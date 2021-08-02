/*
 * This file is part of TbSync.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

const TBSYNC_ID = "tbsync@jobisoft.de";

export var StatusData = class {
  /**
   * A StatusData instance must be used as return value by 
   * :class:`Base.syncFolderList` and :class:`Base.syncFolder`.
   * 
   * StatusData also defines the possible StatusDataTypes used by the
   * :ref:`TbSyncEventLog`.
   *
   * @param {StatusDataType} type  Status type (see const definitions below)
   * @param {string} message  ``Optional`` A message, which will be used as
   *                          sync status. If this is not a success, it will be
   *                          used also in the :ref:`TbSyncEventLog` as well.
   * @param {string} details  ``Optional``  If this is not a success, it will
   *                          be used as description in the
   *                          :ref:`TbSyncEventLog`.
   *
   */
  constructor(type = "success", message = "", details = "") {
    this.version = "3.0";
    this.type = type; //success, info, warning, error
    this.message = message;
    this.details = details;
  }
  /**
   * Successfull sync. 
   */
  static get SUCCESS() {return "success"};
  /**
   * Sync of the entire account will be aborted.
   */
  static get ERROR() {return "error"};
  /**
   * Sync of this resource will be aborted and continued with next resource.
   */
  static get WARNING() {return "warning"};
  /**
   * Successfull sync, but message and details
   * provided will be added to the event log.
   */
  static get INFO() {return "info"};
  /**
   * Sync of the entire account will be aborted and restarted completely.
   */
  static get ACCOUNT_RERUN() {return "account_rerun"}; 
  /**
   * Sync of the current folder/resource will be restarted.
   */
  static get FOLDER_RERUN() {return "folder_rerun"}; 
}

var Listener = class {
    constructor(handler) {
        this.handler = handler;
    }
    addListener(callback) {
        this.handler.callbacks.push(callback);
    }
}

async function fire(callbacks, payload = []) {
    // Goal: All functions not returning a promise are ignored, all returned promises are raced.
    for (let callback of callbacks) {
        return callback(...payload);
    }
}

export var TbSync = class {
    constructor() {
        this.port = null;
        this.connectPromise = null;
        this.portMap = new Map();
        this.portMessageId = 0;
        
        this.onConnectCallbacks = [];
        this.onDisconnectCallbacks = [];
        this.onMessageCallbacks = [];
        
        this.onConnect = new Listener({callbacks: this.onConnectCallbacks});
        this.onDisconnect = new Listener({callbacks: this.onDisconnectCallbacks});
        this.onMessage = new Listener({callbacks: this.onMessageCallbacks});
    }
    
    async connect(info) {        
        this._connectionEstablished = false;
        if (!this._connectPromise) {
            this._connectPromise = new Promise(resolve => {
                // Wait for connections attempts from TbSync.
                messenger.runtime.onConnectExternal.addListener(port => {
                    // port.name should be "ProviderConnection"
                    if (port.sender.id != TBSYNC_ID)
                        return

                    if (port && !port.error) {
                        this.port = port;
                        this.port.onMessage.addListener(this.portReceiver.bind(this));
                        this.port.onDisconnect.addListener(() => {
                            this.port.onMessage.removeListener(this.portReceiver.bind(this));
                            this.port = null;
                            fire(this.onDisconnectCallbacks);
                        });
                        this._connectionEstablished = true;
                        // Too early - fire(this.onConnectCallbacks);
                        resolve();
                    }
                });

                // React on TbSync being enabled/installed to initiate connection.
                async function sendProviderData() {
                    messenger.runtime.sendMessage(TBSYNC_ID, {
                        command: "InitiateConnect", 
                        provider: "dav", //Obsolete
                        info
                    });
                }
                function introduction(addon) {
                    if (addon.id != TBSYNC_ID)
                        return;
                    sendProviderData();
                }
                messenger.management.onInstalled.addListener(introduction.bind(this));
                messenger.management.onEnabled.addListener(introduction.bind(this));

                // Inform TbSync that we exists and initiate connections.
                messenger.management.get(TBSYNC_ID)
                    .then(async (tbSyncAddon) => {
                        while (!this._connectionEstablished && tbSyncAddon && tbSyncAddon.enabled) {
                            // Send a single ping to trigger a connection request.
                            console.log("Contacting TbSync")
                            await sendProviderData();
                            await new Promise(resolve => window.setTimeout(resolve, 1000))
                        }
                    })
                    .catch((e) => {});
            });
        }        
        return this._connectPromise;
    }
    
    async portReceiver(message, port) {
        // port.name should be "ProviderConnection"
        // We do not need to use this.port, as the port is part of the request.
        if (port.sender.id != TBSYNC_ID)
            return;

        if (!this.addon) {
            this.addon = await messenger.management.getSelf();
        }

        const {origin, id, data} = message;
        if (origin == this.addon.id) {
            // This is an answer for one of our own requests.
            const resolve = this.portMap.get(id);
            this.portMap.delete(id);
            resolve(data);
        } else {
            // This is a request from TbSync, process.
            let [mod,func] = data.command.split(".");
            let parameters = Array.isArray(data.parameters) ? data.parameters : [];
            let rv;
            if (["Base"].includes(mod)) {
                console.log(func);
                rv = await fire(this.onMessageCallbacks, [func, parameters]);
            }
            port.postMessage({origin, id, data: rv});
        }
    }    
    
    async portSend(data) {
        if (!this.addon) {
            this.addon = await messenger.management.getSelf();
        }
        console.log(data);
        return new Promise(resolve => {
            const id = ++this.portMessageId;
            this.portMap.set(id, resolve);
            this.port.postMessage({origin: this.addon.id, id, data});
        });
    }

    /*
     * Wrapper functions to communicate with TbSync
     */
    getAccountProperty(accountID, property) {
        return this.portSend({
            command: "getAccountProperty",
            parameters: [...arguments]
        });
    }
    
    setAccountProperty(accountID, property, value) {
        return this.portSend({
            command: "setAccountProperty",
            parameters: [...arguments]
        });
    }

    resetAccountProperty(accountID, property) {
        return this.portSend({
            command: "resetAccountProperty",
            parameters: [...arguments]
        });
    }

    getAccountProperties(accountID, properties) {
        // Not specifying a properties array will return all props.
        return this.portSend({
            command: "getAccountProperties",
            parameters: [...arguments]
        });
    }
    
    setAccountProperties(accountID, properties) {
        if (!properties) {
          return false;
        }
        return this.portSend({
            command: "setAccountProperties",
            parameters: [...arguments]
        });
    }

    resetAccountProperties(accountID, properties) {
        if (!properties) {
          return false;
        }
        return this.portSend({
            command: "resetAccountProperties",
            parameters: [...arguments]
        });
    }
    
    getFolderProperty(accountID, folderID, property) {
        return this.portSend({
            command: "getFolderProperty",
            parameters: [...arguments]
        });
    }
        
    setFolderProperty(accountID, folderID, property, value) {
        return this.portSend({
            command: "setFolderProperty",
            parameters: [...arguments]
        });
    }

    resetFolderProperty(accountID, folderID, property) {
        return this.portSend({
            command: "resetFolderProperty",
            parameters: [...arguments]
        });
    }

    getFolderProperties(accountID, folderID, properties) {
        // Not specifying a properties array will return all props.
        return this.portSend({
            command: "getFolderProperties",
            parameters: [...arguments]
        });
    }
        
    setFolderProperties(accountID, folderID, properties) {
        if (!properties) {
          return false;
        }
        return this.portSend({
            command: "setFolderProperties",
            parameters: [...arguments]
        });
    }

    resetFolderProperties(accountID, folderID, properties) {
        if (!properties) {
          return false;
        }
        return this.portSend({
            command: "resetFolderProperties",
            parameters: [...arguments]
        });
    }


    createNewFolder(accountID, properties) {
        return this.portSend({
            command: "createNewFolder",
            parameters: [...arguments]
        });
    }
    
    addAccount(properties) {
        return this.portSend({
            command: "addAccount",
            parameters: [...arguments]
        });
    }
    
    getAllAccounts() {
        return this.portSend({
            command: "getAllAccounts",
            parameters: [...arguments]
        });
    }        

    getAllFolders(accountID) {
        return this.portSend({
            command: "getAllFolders",
            parameters: [...arguments]
        });
    }
    
    async getString(key) {
      //spezial treatment of strings with :: like status.httperror::403
      let parts = key.split("::");
      let localized = messenger.i18n.getMessage(parts[0]);
  
      if (!localized) {
        localized = await this.portSend({
            command: "getString",
            parameters: [parts[0]]
        });
      }
      
      if (!localized) {
        localized = key;
      } else {
        //replace placeholders in returned string
        for (let i = 0; i<parts.length; i++) {
          let regex = new RegExp( "##replace\."+i+"##", "g");
          localized = localized.replace(regex, parts[i]);
        }
      }

      return localized;
    }
}