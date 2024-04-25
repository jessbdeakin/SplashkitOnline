"use strict";



class IDBStoredProject extends EventTarget{
    constructor(initializer) {
        super();
        this.initializer = initializer;
        this.projectName = null;
        this.lastKnownWriteTime = 0;
    }

    // Public Facing Methods

    // Project Related
    async attachToProject(storeName){
        this.projectName = storeName;

        // Force an init by performing an empty DB operation
        await this.access(function(){});

        // Initial update of lastKnownWriteTime
        await this.checkForWriteConflicts();

        this.dispatchEvent(new Event("attached"));
    }

    async access(func){
        let RW = new __IDBStoredProjectRW(this);
        try{
            await RW.openDB();
            return await func(RW);
        }
        catch(err){
            throw err;
        }
        finally{
            RW.closeDB();
        }
    }

    async checkForWriteConflicts(){
        if (this.projectName == null) return;

        let storedTime = await this.access((project)=>project.getLastWriteTime());
        if (this.lastKnownWriteTime == 0){
            this.lastKnownWriteTime = storedTime;
        }
        if (storedTime > this.lastKnownWriteTime)
            this.dispatchEvent(new Event("timeConflict"));
    }

    detachFromProject(){
        this.projectName = null;
        this.lastKnownWriteTime = 0;
        this.dispatchEvent(new Event("detached"));
    }

    deleteProject(storeName){
        return new Promise((resolve, reject) => {
            let res = indexedDB.deleteDatabase(storeName);
            res.onerror = function(){reject(res.error);};
            res.onsuccess = function(){resolve();};
        });

    }
};

// Private class - can create by calling the 'access' function on a IDBStoredProject
class __IDBStoredProjectRW{
    constructor(IDBSP) {
        this.owner = IDBSP;
        this.ROOT = -1;// ID for root node
        this.db = null;
        this.doInitialization = false;
        this.performedWrite = false;
    }
    openDB(){
        let IDBFS = this;
        return new Promise(function(resolve, reject){

            if (IDBFS.owner.projectName == null)
                return reject();

            if (IDBFS.db != null)
                reject();

            let openRequest = indexedDB.open(IDBFS.owner.projectName, 1);

            openRequest.onupgradeneeded = function(ev) {
                IDBFS.db = openRequest.result;
                IDBFS.db.createObjectStore("project", {keyPath: "category"});
                let files = IDBFS.db.createObjectStore("files", {keyPath: "nodeId", autoIncrement: true});

                files.createIndex("name", "name", { unique: false });
                files.createIndex("parent", "parent", { unique: false });
                if (ev.oldVersion == 0)
                    IDBFS.doInitialization = true;
            };
            openRequest.onsuccess = async function(e){
                IDBFS.db = openRequest.result;
                if (IDBFS.doInitialization){
                    await IDBFS.owner.initializer(IDBFS);
                    await IDBFS.updateLastWriteTime();
                }
                IDBFS.doInitialization = false;
                resolve();
            };
            openRequest.onerror = function(e){
                IDBFS.owner.dispatchEvent(new Event("connectionFailed"));
                reject();
            };
        });
    }

    closeDB(){
        if (this.performedWrite)
            this.updateLastWriteTime();
        if (this.db != null)
            this.db.close();
        this.db = null;
    }

    async getLastWriteTime(){
        let IDBSP = this;
        return await this.doTransaction("project", "readwrite", async function(t, project){
            let lastTime =  await IDBSP.request(t, function(){
                return project.get("lastWriteTime");
            });
            if (lastTime == undefined || lastTime == null)
                return 0;
            else
                return lastTime.time;
        });
    }

    async updateLastWriteTime(time = null){
        if (time == null)
            time = Date.now();

        let IDBSP = this;
        await this.doTransaction("project", "readwrite", async function(t, project){
            await IDBSP.request(t, function(){
                return project.put({category: "lastWriteTime", time: time});
            });
        });
        this.owner.lastKnownWriteTime = time;
    }


    // File System Related
    async mkdir(path){
        let IDBSP = this;
        let dirName = this.pathFileName(path);
        let parentDirPath = IDBSP.pathDirName(path);
        await this.doTransaction("files", "readwrite", async function(t, files){
            let parentNode = await IDBSP.getNodeFromPath(t, files, parentDirPath);
            
            if (parent == null)
                throw new FSParentDirectoryNotFoundError(parentDirPath);

            if (await IDBSP.getChildNodeWithName(t, files, parentNode, dirName) != null)
                throw new FSNodeConflictError(path);
            
            await IDBSP.makeNode(t, files, dirName, "DIR", null, parentNode);
            let ev = new Event("onMakeDirectory");
            ev.path = path;
            IDBSP.owner.dispatchEvent(ev);
        });
    }

    async writeFile(path, data){
        let IDBSP = this;
        let fileName = this.pathFileName(path);
        let parentDirPath = IDBSP.pathDirName(path);
        await this.doTransaction("files", "readwrite", async function(t, files){
            let parentNode = await IDBSP.getNodeFromPath(t, files, parentDirPath);
            
            if (parentNode == null)
                throw new FSParentDirectoryNotFoundError(parentDirPath);
            
            let node = await IDBSP.getChildNodeWithName(t, files, parentNode, fileName);
            if (node == null){
                await IDBSP.makeNode(t, files, fileName, "FILE", data, parentNode);
            }
            else{
                let nodeInt = await IDBSP.getNode(t, files, node);
                await IDBSP.replaceNode(t, files, nodeInt.nodeId, nodeInt.name, nodeInt.type, data, nodeInt.parent);
            }
            let ev = new Event("onOpenFile");
            ev.path = path;
            IDBSP.owner.dispatchEvent(ev);
            ev = new Event("onWriteToFile");
            ev.path = path;
            IDBSP.owner.dispatchEvent(ev);
        });
    }

    async rename(oldPath, newPath){
        let IDBSP = this;
        let oldPath_dir = this.pathDirName(oldPath);
        let newPath_dir = this.pathDirName(newPath);
        let newPath_name = this.pathFileName(newPath);
        await this.doTransaction("files", "readwrite", async function(t, files){
            let node = await IDBSP.getNodeFromPath(t, files, oldPath);
            
            if (node == null)
                throw new FSNodeNotFoundError(oldPath);
            
            let nodeInt = await IDBSP.getNode(t, files, node);
            if (oldPath_dir != newPath_dir){
                let newPath_Node = await IDBSP.getNodeFromPath(t, files, newPath_dir);
                if (newPath_Node == null)
                    throw new FSParentDirectoryNotFoundError(newPath_dir);
                nodeInt.parent = newPath_Node;
            }

            let tenantNode = await IDBSP.getNodeFromPath(t, files, newPath);
            if (tenantNode != null)
                throw new FSNodeConflictError(newPath);

            await IDBSP.replaceNode(t, files, nodeInt.nodeId, newPath_name, nodeInt.type, nodeInt.data, nodeInt.parent);
            let ev = new Event("onMovePath");
            ev.oldPath = oldPath;
            ev.newPath = newPath;
            IDBSP.owner.dispatchEvent(ev);
        });
    }

    async readFile(path){
        let IDBSP = this;
        return this.doTransaction("files", "readonly", async function(t, files){
            let node = await IDBSP.getNodeFromPath(t, files, path);
            if (node == null)
                throw new FSNodeNotFoundError(path);    

            return (await IDBSP.getNode(t, files, node)).data;
        });
    }

    async unlink(path){
        let IDBSP = this;
        await this.doTransaction("files", "readwrite", async function(t, files){
            let nodeId = await IDBSP.getNodeFromPath(t, files, path);
            if (nodeId == null)
                throw new FSNodeNotFoundError(path);

            await IDBSP.deleteNode(t, files, nodeId);
            
            let ev = new Event("onDeletePath");
            ev.path = path;
            IDBSP.owner.dispatchEvent(ev);
        });
    }

    async rmdir(path, recursive = false){
        let IDBSP = this;
        await this.doTransaction("files", "readwrite", async function(t, files){

            let deleteRecursive = async function(t, files, nodeId, nodePath){
                let childNodes = await IDBSP.getChildNodes(t, files, nodeId);
                for(let childNode of childNodes){
                    if(childNode == null)
                        continue;

                    if(childNode.type == "FILE"){
                        await IDBSP.deleteNode(t, files, childNode.nodeId);

                        let ev = new Event("onDeletePath");
                        ev.path = nodePath+"/"+childNode.name;
                        IDBSP.owner.dispatchEvent(ev);
                    }
                    if(childNode.type == "DIR"){
                        await deleteRecursive(t, files, childNode.nodeId, nodePath+"/"+childNode.name);
                    }
                }

                await IDBSP.deleteNode(t, files, nodeId);

                let ev = new Event("onDeletePath");
                ev.path = nodePath;
                IDBSP.owner.dispatchEvent(ev);
            }

            let nodeId = await IDBSP.getNodeFromPath(t, files, path);
            if (nodeId == null)
                throw new FSNodeNotFoundError(path);

            let node = await IDBSP.getNode(t, files, nodeId);
            if (node == null)
                throw new FSNodeNotFoundError(path);
            if (node.type != "DIR")
                throw new FSInvalidNodeOperation(path, "DIR", "rmdir");

            if(recursive){
                deleteRecursive(t, files, nodeId, path);
            } else {
                await IDBSP.deleteNode(t, files, nodeId);
            
                let ev = new Event("onDeletePath");
                ev.path = path;
                IDBSP.owner.dispatchEvent(ev);
            }
        });
    }
   
    getAllFilesRaw(){
        let IDBSP = this;
        return new Promise((resolve, reject) => {
            let transaction = IDBSP.db.transaction("files", "readonly");
            let files = transaction.objectStore("files");
            let result = files.getAll();

            transaction.onerror = function(){reject(transaction.error);};
            transaction.oncomplete = function(){resolve(result.result);};
        });
    }

    async getFileTree(){
        let IDBSP = this;
        return await this.doTransaction("files", "readonly", async function(t, files){
            async function _internal(node){
                let tree = [];
                for (node of await IDBSP.getChildNodes(t, files, node)){
                    let children = null;
                    if (node.type == "DIR")
                        children = await _internal(node.nodeId);
                    tree.push({
                        label: node.name,
                        children: children
                    });
                }
                return tree;
            }
            return _internal(IDBSP.ROOT);
        });
    }


    // "Private" Methods

    // Transactions Wrappers - to make them promises
    doTransaction(store, state, func)
    {
        return new Promise((resolve, reject) => {
            let transaction = this.db.transaction(store, state);
            let files = transaction.objectStore(store);
            let result = func(transaction, files);

            transaction.onerror = function(){console.log("error");transaction.abort(); reject(transaction.error);};
            transaction.oncomplete = function(){resolve(result);};
        });
    }
    request(transaction, func)
    {
        return new Promise((resolve, reject) => {
            let result = func();
            result.onerror = function(){console.log("error");transaction.abort(); reject(result.error);};
            result.onsuccess = function(){
            resolve(result.result);};
        });
    }

    // Basic Node Handling
    makeNode(transaction, files, name, type, data, parent){
        this.performedWrite = true;
        return this.request(transaction, function(){
            return files.add({name:name, type:type, data:data, parent:parent});
        });
    }
    replaceNode(transaction, files, nodeId, name, type, data, parent){
        this.performedWrite = true;
        return this.request(transaction, function(){
            return files.put({nodeId:nodeId, name:name, type:type, data:data, parent:parent});
        });
    }
    deleteNode(transaction, files, nodeId){
        this.performedWrite = true;
        return this.request(transaction, function(){
            return files.delete(nodeId);
        });
    }
    getNode(transaction, files, nodeId){
        return this.request(transaction, function(){
            return files.get(nodeId);
        });
    }

    // Directory Handling
    async getChildNodeWithName(transaction, files, nodeId, name){
        let children = await this.getChildNodes(transaction, files, nodeId);
        for(let child of children){
            if (child.name == name)
                return child.nodeId;
        }
        return null;
    }

    async getChildNodes(transaction, files, nodeId){
        let filesB = files;
        let result = await this.request(transaction, function(){return filesB.index("parent").getAll(nodeId);});
        return result;
    }

    async getNodeFromPath(transaction, files, path){
        let node = this.ROOT;

        let split = this.splitPath(path);
        for (let dir of split){
            node = await this.getChildNodeWithName(transaction, files, node, dir);
            if (node == null)
                return null;
        }
        return node;
    }

    // String Path Utility Functions
    pathDirName(path){
        return path.substring(0, path.lastIndexOf("/"));
    }
    pathFileName(path){
        return path.substring(path.lastIndexOf("/")+1);
    }
    splitPath(path){
        return path.split("/").slice(1);
    }



}