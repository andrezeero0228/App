var xBrowserSync = xBrowserSync || {};
xBrowserSync.App = xBrowserSync.App || {};

/* ------------------------------------------------------------------------------------
 * Class name:  xBrowserSync.App.PlatformImplementation 
 * Description: Implements xBrowserSync.App.Platform for Firefox extension.
 * ------------------------------------------------------------------------------------ */

xBrowserSync.App.PlatformImplementation = function($http, $interval, $q, $timeout, platform, globals, utility, bookmarks) {
	'use strict';

/* ------------------------------------------------------------------------------------
 * Platform variables
 * ------------------------------------------------------------------------------------ */

	var moduleName = 'xBrowserSync.App.PlatformImplementation', vm, loadingId;
	var menuBookmarksId = 'menu________',
		mobileBookmarksId = 'mobile______',
		otherBookmarksId = 'unfiled_____',
		rootBookmarkId = 'root________',
		toolbarBookmarksId = 'toolbar_____';


/* ------------------------------------------------------------------------------------
 * Constructor
 * ------------------------------------------------------------------------------------ */
    
	var FirefoxImplementation = function() {
		// Inject required platform implementation functions
		platform.AutomaticUpdates.Start = startAutoUpdates;
		platform.AutomaticUpdates.Stop = stopAutoUpdates;
		platform.BackupData = backupData;
		platform.Bookmarks.AddIds = addIdsToBookmarks;
		platform.Bookmarks.Clear = clearBookmarks;
		platform.Bookmarks.Created = bookmarksCreated;
		platform.Bookmarks.Deleted = bookmarksDeleted;
		platform.Bookmarks.Get = getBookmarks;
		platform.Bookmarks.Moved = bookmarksMoved;
		platform.Bookmarks.Populate = populateBookmarks;
		platform.Bookmarks.Updated = bookmarksUpdated;
		platform.GetConstant = getConstant;
        platform.GetCurrentUrl = getCurrentUrl;
		platform.GetPageMetadata = getPageMetadata;
		platform.Init = init;
		platform.Interface.Loading.Hide = hideLoading;
        platform.Interface.Loading.Show = displayLoading;
		platform.Interface.Refresh = refreshInterface;
		platform.LocalStorage.Get = getFromLocalStorage;
		platform.LocalStorage.Set = setInLocalStorage;
		platform.OpenUrl = openUrl;
		platform.Sync = sync;
        
        // Refresh browser action icon on reload
        refreshInterface();
	};


/* ------------------------------------------------------------------------------------
 * Public functions
 * ------------------------------------------------------------------------------------ */
	
	var addIdsToBookmarks = function(xBookmarks) { 
        var deferred = $q.defer();

		// Get all bookmarks into array
		browser.bookmarks.getTree()
			.then(function(bookmarkTreeNodes) {
				var allBookmarks = [];
				
				// Get all local bookmarks into flat array
				bookmarks.Each(bookmarkTreeNodes, function(bookmark) { 
					allBookmarks.push(bookmark); 
				});
 
				// Sort by dateAdded asc 
				allBookmarks = _.sortBy(allBookmarks, function(bookmark) {  
					return bookmark.dateAdded;  
				}); 
 
				var idCounter = allBookmarks.length; 
				
				// Add ids to containers' children 
				var addIdToBookmark = function(bookmark) { 
					var bookmarkId; 
		
					// Check allBookmarks for index 
					bookmarkId = _.findIndex(allBookmarks, function(sortedBookmark) {  
						if (sortedBookmark.title === bookmark.title && 
						sortedBookmark.url === bookmark.url &&
						!sortedBookmark.assigned) {
							return true;
						}
					});
		
					// Otherwise take id from counter and increment 
					if (!_.isUndefined(bookmarkId) && bookmarkId >= 0) { 
						bookmark.id = bookmarkId; 

						// Mark this bookmark as assigned to prevent duplicate ids
						allBookmarks[bookmarkId].assigned = true;
					} 
					else { 
						bookmark.id = idCounter; 
						idCounter++; 
					} 
					
					if (bookmark.children) {
						_.each(bookmark.children, addIdToBookmark);
					}
				}; 
				_.each(xBookmarks, addIdToBookmark);

				return deferred.resolve(xBookmarks);
			});
    
			return deferred.promise;
	};
	
	var backupData = function() {
		// Export bookmarks
		return bookmarks.Export()
            .then(function(data) {
				var date = new Date();
				var minute = ('0' + date.getMinutes()).slice(-2);
				var hour = ('0' + date.getHours()).slice(-2);
				var day = ('0' + date.getDate()).slice(-2);
				var month = ('0' + (date.getMonth() + 1)).slice(-2);
				var year = date.getFullYear();
				var dateString = year + month + day + hour + minute;
				
				// Trigger download 
                var backupLink = document.getElementById('backupLink');
                var fileName = 'xBrowserSyncBackup_' + dateString + '.txt';
                backupLink.setAttribute('download', fileName);
				backupLink.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(JSON.stringify(data)));
				backupLink.click();
                
                // Display message
                var message = platform.GetConstant(globals.Constants.Settings_BackupRestore_BackupSuccess_Message).replace(
                    '{fileName}',
                    fileName);
                
                vm.settings.backupCompletedMessage = message;
			});
	};
	
	var bookmarksCreated = function(xBookmarks, args) {
		var deferred = $q.defer();
		var createInfo = args[1];
		var changedBookmarkIndex;
		
		// Check if created bookmark is a container
		wasContainerChanged(createInfo, xBookmarks)
			.then(function(createdBookmarkIsContainer) {
				if (!!createdBookmarkIsContainer) {
					// Disable sync
					bookmarks.DisableSync();
					return $q.reject({ code: globals.ErrorCodes.ContainerChanged });
				}
		
				// Get local bookmark's parent's corresponding xBookmark and container
				// Check if any containers are before the changed bookmark that would throw off index
				return $q.all([
					findXBookmarkUsingLocalBookmarkId(createInfo.parentId, xBookmarks), 
					getNumContainersBeforeBookmarkIndex(createInfo.parentId, createInfo.index)]);
			})
			.then(function(results) {
				var findParentXBookmark = results[0];
            
				// Do not sync the change if the bookmark's container is the toolbar and toolbar sync is disabled,
				// or if the bookmark's container is root
				if (findParentXBookmark.container && (
					findParentXBookmark.container.title === globals.Bookmarks.ToolbarContainerName && !globals.SyncBookmarksToolbar.Get() ||
					findParentXBookmark.container.title === globals.Bookmarks.RootContainerName)) {
					return deferred.resolve({
						bookmarks: xBookmarks
					});
				}
				
				// Check if both container and parent bookmark were found
				if (!findParentXBookmark.container || !findParentXBookmark.xBookmark) {
					return $q.reject({
						code: globals.ErrorCodes.UpdatedBookmarkNotFound
					});
				}

				// Create new bookmark
				var newXBookmark = new bookmarks.XBookmark(
					createInfo.title, 
					createInfo.url || null,
					createInfo.description,
					createInfo.tags,
					createInfo.children);
				
				if (!!createInfo.newId) {
					// Use new id supplied
					newXBookmark.id = createInfo.newId;
				}
				else {
					// Get new bookmark id
					newXBookmark.id = bookmarks.GetNewBookmarkId(xBookmarks);
				}

				// Add the new bookmark to the parent's children at the correct index
				var numContainers = results[1];
				changedBookmarkIndex = createInfo.index - numContainers;
				findParentXBookmark.xBookmark.children.splice(changedBookmarkIndex, 0, newXBookmark);

				return deferred.resolve({ bookmarks: xBookmarks });
			})
			.catch(deferred.reject);
		
		return deferred.promise;
	};
	
	var bookmarksDeleted = function(xBookmarks, args) {
		var removeInfo = args[1];
		var changedBookmarkIndex, deletedLocalBookmarkParent;
		var deferred = $q.defer();

		// Check if changed bookmark is a container
		wasContainerChanged(removeInfo.node, xBookmarks)
			.then(function(changedBookmarkIsContainer) {
				if (!!changedBookmarkIsContainer) {
					// Disable sync
					bookmarks.DisableSync();
					return $q.reject({ code: globals.ErrorCodes.ContainerChanged });
				}
		
				// Get deleted local bookmark's parent
				return getLocalBookmarkTreeById(removeInfo.parentId);
			})
			.then(function(localBookmark) {
				deletedLocalBookmarkParent = localBookmark;

				// Get local bookmark's parent's corresponding xBookmark and container
				// Check if any containers are before the changed bookmark that would throw off index
				return $q.all([
					findXBookmarkUsingLocalBookmarkId(removeInfo.parentId, xBookmarks), 
					getNumContainersBeforeBookmarkIndex(removeInfo.parentId, removeInfo.index)]);
			})
			.then(function(results) {
				var findParentXBookmark = results[0];
            
				// Check if the Toolbar container was found and Toolbar sync is disabled
				if (!!findParentXBookmark.container && findParentXBookmark.container.title === globals.Bookmarks.ToolbarContainerName && !globals.SyncBookmarksToolbar.Get()) {
					return deferred.resolve({
						bookmarks: xBookmarks
					});
				}
				
				// Check if both container and parent bookmark were found
				if (!findParentXBookmark.container || !findParentXBookmark.xBookmark) {
					return $q.reject({
						code: globals.ErrorCodes.UpdatedBookmarkNotFound
					});
				}

				// Otherwise, remove bookmark at the correct index from parent
				var numContainers = results[1];
				changedBookmarkIndex = removeInfo.index - numContainers;
				var removedBookmark = findParentXBookmark.xBookmark.children.splice(changedBookmarkIndex, 1)[0];

				return deferred.resolve({ 
					bookmarks: xBookmarks, 
					removedBookmark: removedBookmark
				});
			})
			.catch(deferred.reject);
		
		return deferred.promise;
	};
	
	var bookmarksMoved = function(xBookmarks, args) {
		var id = args[0];
		var moveInfo = args[1];
		var movedLocalBookmark;
		var deferred = $q.defer();

		var deleteArgs = [null, {
			index: moveInfo.oldIndex,
			node: {
				title: null,
				url: null
			},
			parentId: moveInfo.oldParentId
		}];

		var createArgs = [null, {
			index: moveInfo.index,
			parentId: moveInfo.parentId,
			id: null,
			title: null,
			url: null,
			children: null,
			description: null,
			tags: null
		}];
		
		// Get moved local bookmark
		getLocalBookmarkTreeById(id)
			.then(function(localBookmark) {
				movedLocalBookmark = localBookmark;

				// Update args bookmark properties
				deleteArgs[1].node.title = movedLocalBookmark.title;
				deleteArgs[1].node.url = movedLocalBookmark.url;

				// Remove from old parent
				return bookmarksDeleted(xBookmarks, deleteArgs);
			})
			.then(function(results) {
				var updatedBookmarks = results.bookmarks; 
				var removedBookmark = results.removedBookmark;

				// Update args bookmark properties
				createArgs[1].title = movedLocalBookmark.title;
				createArgs[1].url = movedLocalBookmark.url;
				if (!!removedBookmark) {
					createArgs[1].newId = removedBookmark.id;
					createArgs[1].children = removedBookmark.children;
					createArgs[1].description = removedBookmark.description;
					createArgs[1].tags = removedBookmark.tags;
				}

				// Create under new parent
				return bookmarksCreated(updatedBookmarks, createArgs);
			})
			.then(function(updatedBookmarks) {
				return deferred.resolve(updatedBookmarks);
			})
			.catch(deferred.reject);

		return deferred.promise;
	};
	
	var bookmarksUpdated = function(xBookmarks, args) {
		var id = args[0];
		var updateInfo = args[1];
		var updatedLocalBookmark, updatedLocalBookmarkParent, changedBookmarkIndex;
		var deferred = $q.defer();

		// Get updated local bookmark
		getLocalBookmarkTreeById(id)
			.then(function(localBookmark) {
				updatedLocalBookmark = localBookmark;

				// Check if changed bookmark is a container
				return wasContainerChanged(updatedLocalBookmark, xBookmarks);
			})
			.then(function(changedBookmarkIsContainer) {
				if (!!changedBookmarkIsContainer) {
					// Disable sync
					bookmarks.DisableSync();
					return $q.reject({ code: globals.ErrorCodes.ContainerChanged });
				}
				
				// Get updated local bookmark parent
				return getLocalBookmarkTreeById(updatedLocalBookmark.parentId);
			})
			.then(function(localBookmark) {
				updatedLocalBookmarkParent = localBookmark;

				// Get local bookmark's parent's corresponding xBookmark and container
				// Check if any containers are before the changed bookmark that would throw off index
				return $q.all([
					findXBookmarkUsingLocalBookmarkId(updatedLocalBookmark.parentId, xBookmarks), 
					getNumContainersBeforeBookmarkIndex(updatedLocalBookmark.parentId, updatedLocalBookmark.index)]);
			})
			.then(function(results) {
				var findParentXBookmark = results[0];
            
				// Check if the Toolbar container was found and Toolbar sync is disabled
				if (!!findParentXBookmark.container && findParentXBookmark.container.title === globals.Bookmarks.ToolbarContainerName && !globals.SyncBookmarksToolbar.Get()) {
					return deferred.resolve({
						bookmarks: xBookmarks
					});
				}
				
				// Check if both container and parent bookmark were found
				if (!findParentXBookmark.container || !findParentXBookmark.xBookmark) {
					return $q.reject({
						code: globals.ErrorCodes.UpdatedBookmarkNotFound
					});
				}

				// Otherwise, update bookmark at correct index
				var numContainers = results[1];
				changedBookmarkIndex = updatedLocalBookmark.index - numContainers;
				var bookmarkToUpdate = findParentXBookmark.xBookmark.children[changedBookmarkIndex];

				bookmarkToUpdate.title = updateInfo.title;
				bookmarkToUpdate.url = updateInfo.url;
				return deferred.resolve({ bookmarks: xBookmarks });
			})
			.catch(deferred.reject);
		
		return deferred.promise;
	};
	
	var clearBookmarks = function() {
		var clearMenu, clearMobile, clearOthers, clearToolbar;

		// Clear menu bookmarks
		clearMenu = browser.bookmarks.getChildren(menuBookmarksId)
			.then(function(results) {
				var promises = [];
				
				if (!!results) {
					for (var i = 0; i < results.length; i++) {
						promises.push(browser.bookmarks.removeTree(results[i].id));
					}
				}

				return $q.all(promises);
			})
			.catch(function(err) {
				// Log error
				utility.LogMessage(
					moduleName, 'clearBookmarks', globals.LogType.Error,
					'Error clearing menu bookmarks; ' + err.stack);
					
				return $q.reject({ code: globals.ErrorCodes.FailedRemoveLocalBookmarks });
			});
		
		// Clear mobile bookmarks
		clearMobile = browser.bookmarks.getChildren(mobileBookmarksId)
			.then(function(results) {
				var promises = [];
				
				if (!!results) {
					for (var i = 0; i < results.length; i++) {
						promises.push(browser.bookmarks.removeTree(results[i].id));
					}
				}

				return $q.all(promises);
			})
			.catch(function(err) {
				// Log error
				utility.LogMessage(
					moduleName, 'clearBookmarks', globals.LogType.Error,
					'Error clearing mobile bookmarks; ' + err.stack);
					
				return $q.reject({ code: globals.ErrorCodes.FailedRemoveLocalBookmarks });
			});
		
		// Clear Other bookmarks
		clearOthers = browser.bookmarks.getChildren(otherBookmarksId)
			.then(function(results) {
				var promises = [];
				
				if (!!results) {
					for (var i = 0; i < results.length; i++) {
						promises.push(browser.bookmarks.removeTree(results[i].id));
					}
				}

				return $q.all(promises);
			})
			.catch(function(err) {
				// Log error
				utility.LogMessage(
					moduleName, 'clearBookmarks', globals.LogType.Error,
					'Error clearing other bookmarks; ' + err.stack);
					
				return $q.reject({ code: globals.ErrorCodes.FailedRemoveLocalBookmarks });
			});
		
		// Clear toolbar
		if (globals.SyncBookmarksToolbar.Get()) {
				clearToolbar = browser.bookmarks.getChildren(toolbarBookmarksId)
					.then(function(results) {
						var promises = [];

						if (!!results) {
							for (var i = 0; i < results.length; i++) {
								promises.push(browser.bookmarks.removeTree(results[i].id));
							}
						}

						return $q.all(promises);
					})
					.catch(function(err) {
						// Log error
						utility.LogMessage(
							moduleName, 'clearBookmarks', globals.LogType.Error,
							'Error clearing toolbar; ' + err.stack);
						
						return reject({ code: globals.ErrorCodes.FailedRemoveLocalBookmarks });
					});
		}
		else {
			clearToolbar = $q.resolve();
		}
			
		return $q.all([clearMenu.promise, clearMobile.promise, clearOthers.promise, clearToolbar.promise]);
	};

	var displayLoading = function(id, deferred) {
		var timeout;
		
		// Return if loading overlay already displayed
		if (!!loadingId) {
			return;
		}
		
		switch (id) {
			// Checking updated service url, wait a moment before displaying loading overlay
			case 'checkingNewServiceUrl':
				timeout = $timeout(function() {
					vm.working = true;
				}, 100);
				break;
			// Loading bookmark metadata, wait a moment before displaying loading overlay
			case 'retrievingMetadata':
				timeout = $timeout(function() {
					vm.working = true;
				}, 500);
				break;
			// Display default overlay
			default:
				timeout = $timeout(function() {
					vm.working = true;
				});
				break;
		}

		loadingId = id;
		return timeout;
	};
	
	var getAsyncChannel = function(syncCallback) {
		// Configure async messaging channel
		var asyncChannel = browser.runtime.connect({ name: globals.Title.Get() });
		
		// Begin listening for sync messages
		asyncChannel.onMessage.addListener(function(msg) {
			if (!msg.command) {
				return;
			}
			
			syncCallback(msg);
		});
		
		return asyncChannel;
	};
	
	var getBookmarks = function(addBookmarkIds) {
		var getOtherBookmarks, getToolbarBookmarks, getMenuBookmarks, getMobileBookmarks;
		addBookmarkIds = addBookmarkIds || true;

		// Get other bookmarks
		getOtherBookmarks = getLocalBookmarkTreeById(otherBookmarksId)
			.then(function(otherBookmarks) {
				if (!!otherBookmarks.children && otherBookmarks.children.length > 0) {
					return getLocalBookmarksAsXBookmarks(otherBookmarks.children);
				}
			});

		// Get toolbar bookmarks
        getToolbarBookmarks = getLocalBookmarkTreeById(toolbarBookmarksId)
			.then(function(toolbarBookmarks) {
				if (!globals.SyncBookmarksToolbar.Get()) {
					return;
				}
				
				if (!!toolbarBookmarks.children && toolbarBookmarks.children.length > 0) {
					return getLocalBookmarksAsXBookmarks(toolbarBookmarks.children);
				}
			});
		
		// Get menu bookmarks
		getMenuBookmarks = getLocalBookmarkTreeById(menuBookmarksId)
			.then(function(menuBookmarks) {
				if (!!menuBookmarks.children && menuBookmarks.children.length > 0) {
					return getLocalBookmarksAsXBookmarks(menuBookmarks.children);
				}
			});
		
		// Get mobile bookmarks
		getMobileBookmarks = getLocalBookmarkTreeById(mobileBookmarksId)
			.then(function(mobileBookmarks) {
				if (!!mobileBookmarks.children && mobileBookmarks.children.length > 0) {
					return getLocalBookmarksAsXBookmarks(mobileBookmarks.children);
				}
			});
		
		return $q.all([getOtherBookmarks, getToolbarBookmarks, getMenuBookmarks, getMobileBookmarks])
			.then(function(results) {
				var otherBookmarks = results[0];
				var toolbarBookmarks = results[1];
				var menuBookmarks = results[2];
				var mobileBookmarks = results[3];
				var xBookmarks = [];

				// Add unfiled container if bookmarks present
				var unfiledBookmarks = bookmarks.GetContainer(globals.Bookmarks.UnfiledContainerName, otherBookmarks, false);
				if (!!unfiledBookmarks && unfiledBookmarks.children.length > 0) {
					var unfiledContainer = bookmarks.GetContainer(globals.Bookmarks.UnfiledContainerName, xBookmarks, true);
					unfiledContainer.children = unfiledBookmarks.children;
				}

				// Add other container if bookmarks present
				var otherBookmarksExcUnfiled = _.reject(otherBookmarks, function(bookmark) { return bookmark.title === globals.Bookmarks.UnfiledContainerName; });
				if (!!otherBookmarksExcUnfiled && otherBookmarksExcUnfiled.length > 0) {
					var otherContainer = bookmarks.GetContainer(globals.Bookmarks.OtherContainerName, xBookmarks, true);
					otherContainer.children = otherBookmarksExcUnfiled;
				}

				// Add toolbar container if bookmarks present
				if (!!toolbarBookmarks && toolbarBookmarks.length > 0) {
					var toolbarContainer = bookmarks.GetContainer(globals.Bookmarks.ToolbarContainerName, xBookmarks, true);
					toolbarContainer.children = toolbarBookmarks;
				}

				// Add menu container if bookmarks present
				if (!!menuBookmarks && menuBookmarks.length > 0) {
					var menuContainer = bookmarks.GetContainer(globals.Bookmarks.MenuContainerName, xBookmarks, true);
					menuContainer.children = menuBookmarks;
				}

				// Add mobile container if bookmarks present
				if (!!mobileBookmarks && mobileBookmarks.length > 0) {
					var mobileContainer = bookmarks.GetContainer(globals.Bookmarks.MobileContainerName, xBookmarks, true);
					mobileContainer.children = mobileBookmarks;
				}

				// Add unique ids
				return addIdsToBookmarks(xBookmarks);
			});
	};
	
	var getConstant = function(constName) {
		return browser.i18n.getMessage(constName);
	};
	
	var getCurrentUrl = function() {
        var deferred = $q.defer();
		
		// Get current tab
        browser.tabs.query({ currentWindow: true, active: true })
			.then(function(tabs) {
                deferred.resolve(tabs[0].url);
        	})
			.catch(deferred.reject);
		
		return deferred.promise;
    };
    
    var getFromLocalStorage = function(itemName) {
		return localStorage.getItem(itemName);
	};
    
    var getPageMetadata = function() {
        // Get current tab
        return browser.tabs.query({ active: true, currentWindow: true })
            .then(function(tabs) {
				var activeTab = tabs[0];
				
				// Exit if this is a firefox settings page
				if (activeTab.url.toLowerCase().startsWith('about:')) {
					return new bookmarks.XBookmark(null, activeTab.url);
				}

				// Run content script to return page metadata
				return browser.tabs.executeScript(activeTab.id, { allFrames: false, file: '/js/content.js' })
					.then(function(results) {
						if (!!results && results.length > 0) {
							var pageMetadata = results[0];
							return new bookmarks.XBookmark(
								pageMetadata.title, 
								pageMetadata.url, 
								pageMetadata.description, 
								pageMetadata.tags);
						}
					});
        	});
    };

	var hideLoading = function(id, timeout) {
		if (!!timeout) {
			$timeout.cancel(timeout);
		}
		
		// Hide loading overlay if supplied if matches current
		if (!loadingId || id === loadingId) {
			vm.working = false;
			loadingId = null;
		}
	};

	var init = function(viewModel, scope) {
		// Set global variables
		vm = viewModel;

		// Set platform
		vm.platformName = globals.Platforms.Firefox;
		
		// Enable event listeners
        globals.DisableEventListeners.Set(false);

		// Get async channel for syncing in background
        viewModel.sync.asyncChannel = getAsyncChannel(function(msg) {
            viewModel.scope.$apply(function() {
                viewModel.events.handleSyncResponse(msg);
            });
        });

		// If logged in, focus on search box, otherwise focus on login field
		$timeout(function() {
			if (!!globals.SyncEnabled.Get()) {
				document.querySelector('input[name=txtSearch]').focus();
				
			}
			else {
				if (!!vm.settings.displayNewSyncPanel) {
					document.querySelector('.login-form-new input[name="txtPassword"]').focus();
				}
				else {
					// Focus on password field if id already set
					var inputField = globals.Id.Get() ?
						document.querySelector('.login-form-existing input[name="txtPassword"]') :
						document.querySelector('.login-form-existing input[name="txtId"]');
					if (!!inputField) {
						inputField.focus();
					}
				}
			}
		}, 500);
	};

	var openUrl = function(url) {
		// Get current tab
        browser.tabs.query({ currentWindow: true, active: true })
            .then(function(tabs) {
				var activeTab = tabs[0];
				var tabAction;
				
				// Open url in current tab if new
				if (!!activeTab.url && activeTab.url.startsWith('about:newtab')) {
					tabAction = browser.tabs.update(activeTab.id, { url: url });
				}
				else {
					tabAction = browser.tabs.create({ 'url': url });
				}

				// Close the extension window
				tabAction.then(function() {
					window.close();
				});
        });
	};
	
	var populateBookmarks = function(xBookmarks) {
		// Get containers
		var menuContainer = bookmarks.GetContainer(globals.Bookmarks.MenuContainerName, xBookmarks);
		var mobileContainer = bookmarks.GetContainer(globals.Bookmarks.MobileContainerName, xBookmarks);
		var otherContainer = bookmarks.GetContainer(globals.Bookmarks.OtherContainerName, xBookmarks);
		var toolbarContainer = bookmarks.GetContainer(globals.Bookmarks.ToolbarContainerName, xBookmarks);
		var unfiledContainer = bookmarks.GetContainer(globals.Bookmarks.UnfiledContainerName, xBookmarks);
		
		// Create unfiled bookmarks in other bookmarks
		var populateUnfiled = $q(function(resolve, reject) {
			if (!!unfiledContainer && unfiledContainer.children.length > 0) {
				try {
					browser.bookmarks.get(otherBookmarksId, function(results) {
						createLocalBookmarksFromXBookmarks(otherBookmarksId, [unfiledContainer], resolve, reject);
					});
				}
				catch (err) {
					// Log error
					utility.LogMessage(
						moduleName, 'populateBookmarks', globals.LogType.Error,
						'Error populating unfiled bookmarks; ' + err.stack);
					
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
				}
			}
			else {
				resolve();
			}
		});
		
		// Create other bookmarks
		var populateOther = $q(function(resolve, reject) {
			if (!!otherContainer && otherContainer.children.length > 0) {
				try {
					browser.bookmarks.get(otherBookmarksId, function(results) {
						createLocalBookmarksFromXBookmarks(otherBookmarksId, otherContainer.children, resolve, reject);
					});
				}
				catch (err) {
					// Log error
					utility.LogMessage(
						moduleName, 'populateBookmarks', globals.LogType.Error,
						'Error populating other bookmarks; ' + err.stack);
					
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
				}
			}
			else {
				resolve();
			}
		});

		// Create toolbar bookmarks
		var populateToolbar = $q(function(resolve, reject) {
			if (globals.SyncBookmarksToolbar.Get() && !!toolbarContainer && toolbarContainer.children.length > 0) {
				try {
                    browser.bookmarks.get(toolbarBookmarksId, function(results) {
                        createLocalBookmarksFromXBookmarks(toolbarBookmarksId, toolbarContainer.children, resolve, reject);
                    });
                }
                catch (err) {
                    // Log error
					utility.LogMessage(
						moduleName, 'populateBookmarks', globals.LogType.Error,
						'Error populating toolbar; ' + err.stack);
					
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
                }
			}
			else {
				resolve();
			}
		});

		// Create menu bookmarks
		var populateMenu = $q(function(resolve, reject) {
			if (!!menuContainer && menuContainer.children.length > 0) {
				try {
                    browser.bookmarks.get(menuBookmarksId, function(results) {
                        createLocalBookmarksFromXBookmarks(menuBookmarksId, menuContainer.children, resolve, reject);
                    });
                }
                catch (err) {
                    // Log error
					utility.LogMessage(
						moduleName, 'populateBookmarks', globals.LogType.Error,
						'Error populating menu; ' + err.stack);
					
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
                }
			}
			else {
				resolve();
			}
		});

		// Create mobile bookmarks
		var populateMobile = $q(function(resolve, reject) {
			if (!!mobileContainer && mobileContainer.children.length > 0) {
				try {
                    browser.bookmarks.get(mobileBookmarksId, function(results) {
                        createLocalBookmarksFromXBookmarks(mobileBookmarksId, mobileContainer.children, resolve, reject);
                    });
                }
                catch (err) {
                    // Log error
					utility.LogMessage(
						moduleName, 'populateBookmarks', globals.LogType.Error,
						'Error populating mobile; ' + err.stack);
					
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
                }
			}
			else {
				resolve();
			}
		});
		
		return $q.all([populateUnfiled, populateOther, populateToolbar, populateMenu, populateMobile])
			.then(reorderLocalContainers);
	};
	
	var refreshInterface = function() {
		var iconPath;
		var tooltip = getConstant(globals.Constants.Title);
		
		if (!!globals.IsSyncing.Get()) {
			iconPath = 'img/browser-action-working.png';
			tooltip += ' - ' + getConstant(globals.Constants.TooltipWorking_Label);
		}
		else if (!!globals.SyncEnabled.Get()) {
			iconPath = 'img/browser-action-on.png';
			tooltip += ' - ' + getConstant(globals.Constants.TooltipSyncEnabled_Label);
		}
		else {
			iconPath = 'img/browser-action-off.png';
		}
        
		browser.browserAction.setIcon({ path: iconPath });
		browser.browserAction.setTitle({ title: tooltip });
	};
	
	var setInLocalStorage = function(itemName, itemValue) {
		localStorage.setItem(itemName, itemValue);
	};

	var startAutoUpdates = function() {
		// Register alarm
		return browser.alarms.clear(globals.Alarm.Name.Get())
			.then(function() {
				return browser.alarms.create(
					globals.Alarm.Name.Get(), {
						periodInMinutes: globals.Alarm.Period.Get()
					});
			})
			.catch(function(err) {
				// Log error
				utility.LogMessage(
					moduleName, 'startAutoUpdates', globals.LogType.Warning,
					'Error registering alarm; ' + err.stack);
					
				return $q.reject({ code: globals.ErrorCodes.FailedRegisterAutoUpdates });
			});
	};

	var stopAutoUpdates = function() {
		browser.alarms.clear(globals.Alarm.Name.Get());
	};
	
	var sync = function(asyncChannel, syncData, command) {
		syncData.command = (!!command) ? command : globals.Commands.SyncBookmarks;
		asyncChannel.postMessage(syncData);
	};
	
 
/* ------------------------------------------------------------------------------------
 * Private functions
 * ------------------------------------------------------------------------------------ */
    
	var checkForLocalContainer = function(localBookmark) {
        var localContainers = [
			{ id: menuBookmarksId, xBookmarkTitle: globals.Bookmarks.MenuContainerName },
            { id: mobileBookmarksId, xBookmarkTitle: globals.Bookmarks.MobileContainerName },
			{ id: otherBookmarksId, xBookmarkTitle: globals.Bookmarks.OtherContainerName },
			{ id: rootBookmarkId, xBookmarkTitle: globals.Bookmarks.RootContainerName },
            { id: toolbarBookmarksId, xBookmarkTitle: globals.Bookmarks.ToolbarContainerName }
        ];
		
		// Check if the bookmark id is a local container
        var localContainer = _.findWhere(localContainers, { id: localBookmark.id });

        // If the bookmark is not a local container, check if it is an xBrowserSync container
        if (!localContainer && bookmarks.IsBookmarkContainer(localBookmark)) {
            localContainer = { id: localBookmark.id, xBookmarkTitle: globals.Bookmarks.UnfiledContainerName };
        }

        return localContainer;
    };

    var createLocalBookmark = function(parentId, title, url, index) {
		var deferred = $q.defer();
		
		try {
			var newLocalBookmark = {
				index: index,
				parentId: parentId,
				title: title,
				url: url
			};
			
			browser.bookmarks.create(newLocalBookmark, function(result) {
				deferred.resolve(result);
			});
		}
		catch(err) {
			// Log error
			utility.LogMessage(
				moduleName, 'createLocalBookmark', globals.LogType.Error,
				err.stack);
			
			deferred.reject({ code: globals.ErrorCodes.FailedCreateLocalBookmarks });
		}
		
		return deferred.promise;
	};
    
    var createLocalBookmarksFromXBookmarks = function(parentId, xBookmarks, success, failed) {
		(function step(i, callback) {
			if (i < xBookmarks.length) {
				createLocalBookmark(parentId, xBookmarks[i].title, xBookmarks[i].url, i).then(
					function(newLocalBookmark) {
						var xBookmark = xBookmarks[i];
						
						if (!!xBookmark.children && xBookmark.children.length > 0) {
							createLocalBookmarksFromXBookmarks(newLocalBookmark.id, xBookmark.children,
								function() {
									step(i + 1, callback);
								},
								failed);
						}
						else {
							step(i + 1, callback);
						}
					},
					function(err) {
						failed(err);
					});
			}
			else {
				callback();
			}
		})(0, function() {
			success();
		});
	};

	var findLocalBookmarkByTitle = function(title) {
		if (!title) {
			return $q.resolve();
		}

		return browser.bookmarks.search({ title: title })
			.then(function(results) {
				var localBookmark;
				if (results.length > 0) {
					localBookmark = results.shift();
				}
				
				return localBookmark;
			});
	};

	var findXBookmarkUsingLocalBookmarkId = function(localBookmarkId, xBookmarks) {
        var deferred = $q.defer();
        var indexTree = [];
        var result = {
            container: null,
            xBookmark: null
        };
        
        (function loop(bookmarkId) {
            var bookmark, bookmarkIndex;
            
            getLocalBookmarkTreeById(bookmarkId)
                .then(function(localBookmark) {
                    // If the local bookmark is a container, use the index tree to get the xBookmark
                    var localContainer = checkForLocalContainer(localBookmark);
                    if (!!localContainer) {
                        if (localContainer.xBookmarkTitle === globals.Bookmarks.RootContainerName) {
							return deferred.resolve({
								container: {
									title: globals.Bookmarks.RootContainerName
								}
							});
						}
						
						// Get the xBookmark that corresponds to the container
						var container = bookmarks.GetContainer(localContainer.xBookmarkTitle, xBookmarks, true);

                        // Follow the index tree from the container to find the required xBookmark
                        var currentXBookmark = container;                        
                        while (indexTree.length > 0) {
                            var index = indexTree.splice(0, 1)[0];

                            if (!currentXBookmark.children || currentXBookmark.children.length === 0 || !currentXBookmark.children[index]) {
                                return deferred.reject({ code: globals.ErrorCodes.XBookmarkNotFound });
                            }

                            currentXBookmark = currentXBookmark.children[index];
                        }

                        // Return the located xBookmark and corresponding container
                        result.container = container;
                        result.xBookmark = currentXBookmark;                        
                        return deferred.resolve(result);
                    }
                    
                    bookmark = localBookmark;

                    // Check if any containers are before the bookmark that would throw off synced index
				    return getNumContainersBeforeBookmarkIndex(bookmark.parentId, bookmark.index)
                        .then(function(numContainers) {
                            // Add the bookmark's synced index to the index tree
                            bookmarkIndex = bookmark.index - numContainers;
                            indexTree.unshift(bookmarkIndex);

                            // Run the next iteration for the bookmark's parent
                            loop(bookmark.parentId);
                        })
                        .catch(deferred.reject);
                })
                .catch(deferred.reject);
        })(localBookmarkId);

        return deferred.promise;
    };

	var getLocalBookmarkTreeById = function(localBookmarkId) {
		var deferred = $q.defer();

		browser.bookmarks.getSubTree(localBookmarkId)
			.then(function(results) {
				if (results && results.length > 0) {
					deferred.resolve(results[0]);
				}
			})
			.catch(deferred.reject);
		
		return deferred.promise;
	};
	
	var getLocalBookmarksAsXBookmarks = function(localBookmarks) {
		var xBookmarks = [];
		
		for (var i = 0; i < localBookmarks.length; i++) {
			var currentLocalBookmark = localBookmarks[i];
			
			// Do not sync separators
			if (currentLocalBookmark.type === 'separator') {
				continue;
			}
			
			var newXBookmark = new bookmarks.XBookmark(currentLocalBookmark.title, currentLocalBookmark.url);
			
			// If this is a folder and has children, process them
			if (!!currentLocalBookmark.children && currentLocalBookmark.children.length > 0) {
				newXBookmark.children = getLocalBookmarksAsXBookmarks(currentLocalBookmark.children);
			}
			
			xBookmarks.push(newXBookmark);
		}
		
		return xBookmarks;
	};

	var getNumContainersBeforeBookmarkIndex = function(parentId, bookmarkIndex) {
		return getLocalBookmarkTreeById(parentId)
			.then(function(localBookmark) {
				var preceedingBookmarks = _.filter(localBookmark.children, function(bookmark) {
					return bookmark.index < bookmarkIndex;
				});
				var containers = _.filter(preceedingBookmarks, bookmarks.IsBookmarkContainer);
				
				if (!!containers) {
					return containers.length;
				}
				else {
					return 0;
				}
			});
	};

	var reorderLocalContainers = function() {
		var containers = [
			globals.Bookmarks.UnfiledContainerName
		];

		// Get local containers
		return $q.all(containers.map(findLocalBookmarkByTitle))
			.then(function(results) {
				// Remove falsy results
				var localContainers = results.filter(function(x) { return x; });
				
				// Reorder each local container to top of parent
				return $q.all(localContainers.map(function(localContainer, index) {
					return browser.bookmarks.move(
						localContainer.id,
						{
							index: index,
							parentId: localContainer.parentId
						}
					);
				}));
			})
	};

	var wasContainerChanged = function(changedBookmark, xBookmarks) {
		// Check based on title
		if (bookmarks.IsBookmarkContainer(changedBookmark)) {
			return $q.resolve(true);
		}
		
		// If parent is Other bookmarks, check Other bookmarks children for containers
		if (!!changedBookmark.parentId && changedBookmark.parentId === otherBookmarksId) {
			return $q(function(resolve, reject) {
				try {
					browser.bookmarks.getChildren(otherBookmarksId, function(children) {
						// Get all bookmarks in other bookmarks that are xBrowserSync containers
						var localContainers = children.filter(function(x) {
							return x.title.indexOf(globals.Bookmarks.ContainerPrefix) === 0;
						});
						var containersCount = 0;
						var checksFailed = false;

						// Check each container present only appears once
						var unfiledContainer = bookmarks.GetContainer(globals.Bookmarks.UnfiledContainerName, xBookmarks, false);
						if (unfiledContainer) {
							containersCount++;
							var count = localContainers.filter(function(x) {
								return x.title === globals.Bookmarks.UnfiledContainerName;
							}).length;
							checksFailed = count !== 1 ? true : checksFailed;
						}

						// Check number of containers match and return result
						checksFailed = containersCount !== localContainers.length ? true : checksFailed;
						resolve(checksFailed);
					});
				}
				catch (err) {
					// Log error
					utility.LogMessage(
						moduleName, 'wasContainerChanged', globals.LogType.Warning,
						'Error getting local containers; ' + err.stack);
						
					return reject({ code: globals.ErrorCodes.FailedGetLocalBookmarks });
				}
			});
		}

		return $q.resolve(false);
	};
	
	// Call constructor
	return new FirefoxImplementation();
};