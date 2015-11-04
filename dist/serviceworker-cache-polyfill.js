(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
if(!window.caches) window.caches = require('../lib/caches.js');
},{"../lib/caches.js":4}],2:[function(require,module,exports){
var cacheDB = require('./cachedb');

function Cache() {
  this._name = '';
  this._origin = '';
}

var CacheProto = Cache.prototype;

CacheProto.match = function(request, params) {
  return cacheDB.match(this._origin, this._name, request, params);
};

CacheProto.matchAll = function(request, params) {
  return cacheDB.matchAll(this._origin, this._name, request, params);
};

CacheProto.addAll = function(requests) {
  return Promise.all(
    requests.map(function(request) {
      return fetch(request);
    })
  ).then(function(responses) {
    return cacheDB.put(this._origin, this._name, responses.map(function(response, i) {
      return [requests[i], response];
    }));
  }.bind(this));
};

CacheProto.add = function(request) {
  return this.addAll([request]);
};

CacheProto.put = function(request, response) {
  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

CacheProto.delete = function(request, params) {
  return cacheDB.delete(this._origin, this._name, request, params);
};

CacheProto.keys = function(request, params) {
  if (request) {
    return cacheDB.matchAllRequests(this._origin, this._name, request, params);
  }
  else {
    return cacheDB.allRequests(this._origin, this._name);
  }
};

module.exports = Cache;

},{"./cachedb":3}],3:[function(require,module,exports){
var IDBHelper = require('./idbhelper');

function matchesVary(request, entryRequest, entryResponse) {
  if (!entryResponse.headers.vary) {
    return true;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;
  var requestHeaders = flattenHeaders(request.headers);

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    if (entryRequest.headers[varyHeader] != requestHeaders[varyHeader]) {
      return false;
    }
  }
  return true;
}

function createVaryID(entryRequest, entryResponse) {
  var id = '';

  if (!entryResponse.headers.vary) {
    return id;
  }

  var varyHeaders = entryResponse.headers.vary.toLowerCase().split(',');
  var varyHeader;

  for (var i = 0; i < varyHeaders.length; i++) {
    varyHeader = varyHeaders[i].trim();

    if (varyHeader == '*') {
      continue;
    }

    id += varyHeader + ': ' + (entryRequest.headers[varyHeader] || '') + '\n';
  }

  return id;
}

function flattenHeaders(headers) {
  var returnVal = {};

  headers.forEach(function (value, name) {
    returnVal[name.toLowerCase()] = value;
  });

  return returnVal;
}

function entryToResponse(entry) {
  var entryResponse = entry.response;
  return new Response(entryResponse.body, {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: body,
    status: response.status,
    statusText: response.statusText,
    headers: flattenHeaders(response.headers)
  };
}

function entryToRequest(entry) {
  var entryRequest = entry.request;
  return new Request(entryRequest.url, {
    mode: entryRequest.mode,
    headers: entryRequest.headers,
    credentials: entryRequest.headers
  });
}

function requestToEntry(request) {
  return {
    url: request.url,
    mode: request.mode,
    credentials: request.credentials,
    headers: flattenHeaders(request.headers)
  };
}

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

function CacheDB() {
  this.db = new IDBHelper('cache-polyfill', 1, function(db, oldVersion) {
    switch (oldVersion) {
      case 0:
        var namesStore = db.createObjectStore('cacheNames', {
          keyPath: ['origin', 'name']
        });
        namesStore.createIndex('origin', ['origin', 'added']);

        var entryStore = db.createObjectStore('cacheEntries', {
          keyPath: ['origin', 'cacheName', 'request.url', 'varyID']
        });
        entryStore.createIndex('origin-cacheName', ['origin', 'cacheName', 'added']);
        entryStore.createIndex('origin-cacheName-urlNoSearch', ['origin', 'cacheName', 'requestUrlNoSearch', 'added']);
        entryStore.createIndex('origin-cacheName-url', ['origin', 'cacheName', 'request.url', 'added']);
    }
  });
}

var CacheDBProto = CacheDB.prototype;

CacheDBProto._eachCache = function(tx, origin, eachCallback, doneCallback, errorCallback) {
  IDBHelper.iterate(
    tx.objectStore('cacheNames').index('origin').openCursor(IDBKeyRange.bound([origin, 0], [origin, Infinity])),
    eachCallback, doneCallback, errorCallback
  );
};

CacheDBProto._eachMatch = function(tx, origin, cacheName, request, eachCallback, doneCallback, errorCallback, params) {
  params = params || {};

  var ignoreSearch = Boolean(params.ignoreSearch);
  var ignoreMethod = Boolean(params.ignoreMethod);
  var ignoreVary = Boolean(params.ignoreVary);
  var prefixMatch = Boolean(params.prefixMatch);

  if (!ignoreMethod &&
      request.method !== 'GET' &&
      request.method !== 'HEAD') {
    // we only store GET responses at the moment, so no match
    return Promise.resolve();
  }

  var cacheEntries = tx.objectStore('cacheEntries');
  var range;
  var index;
  var indexName = 'origin-cacheName-url';
  var urlToMatch = new URL(request.url);

  urlToMatch.hash = '';

  if (ignoreSearch) {
    urlToMatch.search = '';
    indexName += 'NoSearch';
  }

  // working around chrome bugs
  urlToMatch = urlToMatch.href.replace(/(\?|#|\?#)$/, '');

  index = cacheEntries.index(indexName);

  if (prefixMatch) {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch + String.fromCharCode(65535), Infinity]);
  }
  else {
    range = IDBKeyRange.bound([origin, cacheName, urlToMatch, 0], [origin, cacheName, urlToMatch, Infinity]);
  }

  IDBHelper.iterate(index.openCursor(range), function(cursor) {
    var value = cursor.value;
    
    if (ignoreVary || matchesVary(request, cursor.value.request, cursor.value.response)) {
      // it's down to the callback to call cursor.continue()
      eachCallback(cursor);
    }
  }, doneCallback, errorCallback);
};

CacheDBProto._hasCache = function(tx, origin, cacheName, doneCallback, errCallback) {
  var store = tx.objectStore('cacheNames');
  return IDBHelper.callbackify(store.get([origin, cacheName]), function(val) {
    doneCallback(!!val);
  }, errCallback);
};

CacheDBProto._delete = function(tx, origin, cacheName, request, doneCallback, errCallback, params) {
  var returnVal = false;

  this._eachMatch(tx, origin, cacheName, request, function(cursor) {
    returnVal = true;
    cursor.delete();
    cursor.continue();
  }, function() {
    if (doneCallback) {
      doneCallback(returnVal);
    }
  }, errCallback, params);
};

CacheDBProto.matchAllRequests = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.key);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.allRequests = function(origin, cacheName) {
  var matches = [];

  return this.db.transaction('cacheEntries', function(tx) {
    var cacheEntries = tx.objectStore('cacheEntries');
    var index = cacheEntries.index('origin-cacheName');

    IDBHelper.iterate(index.openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])), function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    });
  }).then(function() {
    return matches.map(entryToRequest);
  });
};

CacheDBProto.matchAll = function(origin, cacheName, request, params) {
  var matches = [];

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      matches.push(cursor.value);
      cursor.continue();
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return matches.map(entryToResponse);
  });
};

CacheDBProto.match = function(origin, cacheName, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._eachMatch(tx, origin, cacheName, request, function(cursor) {
      match = cursor.value;
    }, undefined, undefined, params);
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.matchAcrossCaches = function(origin, request, params) {
  var match;

  request = castToRequest(request);

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    this._eachCache(tx, origin, function(namesCursor) {
      var cacheName = namesCursor.value.name;

      this._eachMatch(tx, origin, cacheName, request, function each(responseCursor) {
        match = responseCursor.value;
      }, function done() {
        if (!match) {
          namesCursor.continue();
        }
      }, undefined, params);
    }.bind(this));
  }.bind(this)).then(function() {
    return match ? entryToResponse(match) : undefined;
  });
};

CacheDBProto.cacheNames = function(origin) {
  var names = [];

  return this.db.transaction('cacheNames', function(tx) {
    this._eachCache(tx, origin, function(cursor) {
      names.push(cursor.value.name);
      cursor.continue();
    }.bind(this));
  }.bind(this)).then(function() {
    return names;
  });
};

CacheDBProto.delete = function(origin, cacheName, request, params) {
  var returnVal;

  request = castToRequest(request);

  return this.db.transaction('cacheEntries', function(tx) {
    this._delete(tx, origin, cacheName, request, params, function(v) {
      returnVal = v;
    });
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.openCache = function(origin, cacheName) {
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      if (val) { return; }
      var store = tx.objectStore('cacheNames');
      store.add({
        origin: origin,
        name: cacheName,
        added: Date.now()
      });
    });
  }.bind(this), {mode: 'readwrite'});
};

CacheDBProto.hasCache = function(origin, cacheName) {
  var returnVal;
  return this.db.transaction('cacheNames', function(tx) {
    this._hasCache(tx, origin, cacheName, function(val) {
      returnVal = val;
    });
  }.bind(this)).then(function(val) {
    return returnVal;
  });
};

CacheDBProto.deleteCache = function(origin, cacheName) {
  var returnVal = false;

  return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
    IDBHelper.iterate(
      tx.objectStore('cacheNames').openCursor(IDBKeyRange.only([origin, cacheName])),
      del
    );

    IDBHelper.iterate(
      tx.objectStore('cacheEntries').index('origin-cacheName').openCursor(IDBKeyRange.bound([origin, cacheName, 0], [origin, cacheName, Infinity])),
      del
    );

    function del(cursor) {
      returnVal = true;
      cursor.delete();
      cursor.continue();
    }
  }.bind(this), {mode: 'readwrite'}).then(function() {
    return returnVal;
  });
};

CacheDBProto.put = function(origin, cacheName, items) {
  // items is [[request, response], [request, response], …]
  var item;

  for (var i = 0; i < items.length; i++) {
    items[i][0] = castToRequest(items[i][0]);

    if (items[i][0].method != 'GET') {
      return Promise.reject(TypeError('Only GET requests are supported'));
    }

    if (items[i][1].type == 'opaque') {
      return Promise.reject(TypeError("The polyfill doesn't support opaque responses (from cross-origin no-cors requests)"));
    }

    // ensure each entry being put won't overwrite earlier entries being put
    for (var j = 0; j < i; j++) {
      if (items[i][0].url == items[j][0].url && matchesVary(items[j][0], items[i][0], items[i][1])) {
        return Promise.reject(TypeError('Puts would overwrite eachother'));
      }
    }
  }

  return Promise.all(
    items.map(function(item) {
      return item[1].blob();
    })
  ).then(function(responseBodies) {
    return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
      this._hasCache(tx, origin, cacheName, function(hasCache) {
        if (!hasCache) {
          throw Error("Cache of that name does not exist");
        }

        items.forEach(function(item, i) {
          var request = item[0];
          var response = item[1];
          var requestEntry = requestToEntry(request);
          var responseEntry = responseToEntry(response, responseBodies[i]);

          var requestUrlNoSearch = new URL(request.url);
          requestUrlNoSearch.search = '';
          // working around Chrome bug
          requestUrlNoSearch = requestUrlNoSearch.href.replace(/\?$/, '');

          this._delete(tx, origin, cacheName, request, function() {
            tx.objectStore('cacheEntries').add({
              origin: origin,
              cacheName: cacheName,
              request: requestEntry,
              response: responseEntry,
              requestUrlNoSearch: requestUrlNoSearch,
              varyID: createVaryID(requestEntry, responseEntry),
              added: Date.now()
            });
          });

        }.bind(this));
      }.bind(this));
    }.bind(this), {mode: 'readwrite'});
  }.bind(this)).then(function() {
    return undefined;
  });
};

module.exports = new CacheDB();
},{"./idbhelper":5}],4:[function(require,module,exports){
var cacheDB = require('./cachedb');
var Cache = require('./cache');

function CacheStorage() {
  this._origin = location.origin;
}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto._vendCache = function(name) {
  var cache = new Cache();
  cache._name = name;
  cache._origin = this._origin;
  return cache;
};

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(this._origin, request, params);
};

CacheStorageProto.has = function(name) {
  return cacheDB.hasCache(this._origin, name);
};

CacheStorageProto.open = function(name) {
  return cacheDB.openCache(this._origin, name).then(function() {
    return this._vendCache(name);
  }.bind(this));
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

CacheStorageProto.keys = function() {
  return cacheDB.cacheNames(this._origin);
};

module.exports = new CacheStorage();

},{"./cache":2,"./cachedb":3}],5:[function(require,module,exports){
function IDBHelper(name, version, upgradeCallback) {
  var request = (self._indexedDB || self.indexedDB).open(name, version);
  this.ready = IDBHelper.promisify(request);
  request.onupgradeneeded = function(event) {
    upgradeCallback(request.result, event.oldVersion);
  };
}

IDBHelper.supported = '_indexedDB' in self || 'indexedDB' in self;

IDBHelper.promisify = function(obj) {
  return new Promise(function(resolve, reject) {
    IDBHelper.callbackify(obj, resolve, reject);
  });
};

IDBHelper.callbackify = function(obj, doneCallback, errCallback) {
  function onsuccess(event) {
    if (doneCallback) {
      doneCallback(obj.result);
    }
    unlisten();
  }
  function onerror(event) {
    if (errCallback) {
      errCallback(obj.error);
    }
    unlisten();
  }
  function unlisten() {
    obj.removeEventListener('complete', onsuccess);
    obj.removeEventListener('success', onsuccess);
    obj.removeEventListener('error', onerror);
    obj.removeEventListener('abort', onerror);
  }
  obj.addEventListener('complete', onsuccess);
  obj.addEventListener('success', onsuccess);
  obj.addEventListener('error', onerror);
  obj.addEventListener('abort', onerror);
};

IDBHelper.iterate = function(cursorRequest, eachCallback, doneCallback, errorCallback) {
  var oldCursorContinue;

  function cursorContinue() {
    this._continuing = true;
    return oldCursorContinue.call(this);
  }

  cursorRequest.onsuccess = function() {
    var cursor = cursorRequest.result;

    if (!cursor) {
      if (doneCallback) {
        doneCallback();
      }
      return;
    }

    if (cursor.continue != cursorContinue) {
      oldCursorContinue = cursor.continue;
      cursor.continue = cursorContinue;
    }

    eachCallback(cursor);

    if (!cursor._continuing) {
      if (doneCallback) {
        doneCallback();
      }
    }
  };

  cursorRequest.onerror = function() {
    if (errorCallback) {
      errorCallback(cursorRequest.error);
    }
  };
};

var IDBHelperProto = IDBHelper.prototype;

IDBHelperProto.transaction = function(stores, callback, opts) {
  opts = opts || {};

  return this.ready.then(function(db) {
    var mode = opts.mode || 'readonly';

    var tx = db.transaction(stores, mode);
    callback(tx, db);
    return IDBHelper.promisify(tx);
  });
};

module.exports = IDBHelper;
},{}]},{},[1])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlc1xcYnJvd3NlcmlmeVxcbm9kZV9tb2R1bGVzXFxicm93c2VyLXBhY2tcXF9wcmVsdWRlLmpzIiwiLi9idWlsZC9pbmRleC5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZS5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZWRiLmpzIiwiQzovVXNlcnMvQ0NhdmFsaWVyL0RvY3VtZW50cy9HaXRIdWIvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlcy5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9pZGJoZWxwZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2YUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiaWYoIXdpbmRvdy5jYWNoZXMpIHdpbmRvdy5jYWNoZXMgPSByZXF1aXJlKCcuLi9saWIvY2FjaGVzLmpzJyk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcclxuXHJcbmZ1bmN0aW9uIENhY2hlKCkge1xyXG4gIHRoaXMuX25hbWUgPSAnJztcclxuICB0aGlzLl9vcmlnaW4gPSAnJztcclxufVxyXG5cclxudmFyIENhY2hlUHJvdG8gPSBDYWNoZS5wcm90b3R5cGU7XHJcblxyXG5DYWNoZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2godGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5tYXRjaEFsbCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWxsKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcclxuICByZXR1cm4gUHJvbWlzZS5hbGwoXHJcbiAgICByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xyXG4gICAgICByZXR1cm4gZmV0Y2gocmVxdWVzdCk7XHJcbiAgICB9KVxyXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZXMpIHtcclxuICAgIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcclxuICAgICAgcmV0dXJuIFtyZXF1ZXN0c1tpXSwgcmVzcG9uc2VdO1xyXG4gICAgfSkpO1xyXG4gIH0uYmluZCh0aGlzKSk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmFkZCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcclxuICByZXR1cm4gdGhpcy5hZGRBbGwoW3JlcXVlc3RdKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8ucHV0ID0gZnVuY3Rpb24ocmVxdWVzdCwgcmVzcG9uc2UpIHtcclxuICBpZiAoIShyZXNwb25zZSBpbnN0YW5jZW9mIFJlc3BvbnNlKSkge1xyXG4gICAgdGhyb3cgVHlwZUVycm9yKFwiSW5jb3JyZWN0IHJlc3BvbnNlIHR5cGVcIik7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCBbW3JlcXVlc3QsIHJlc3BvbnNlXV0pO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5kZWxldGUgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5kZWxldGUodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5rZXlzID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgaWYgKHJlcXVlc3QpIHtcclxuICAgIHJldHVybiBjYWNoZURCLm1hdGNoQWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG4gIH1cclxuICBlbHNlIHtcclxuICAgIHJldHVybiBjYWNoZURCLmFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSk7XHJcbiAgfVxyXG59O1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBDYWNoZTtcclxuIiwidmFyIElEQkhlbHBlciA9IHJlcXVpcmUoJy4vaWRiaGVscGVyJyk7XHJcblxyXG5mdW5jdGlvbiBtYXRjaGVzVmFyeShyZXF1ZXN0LCBlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcclxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxuICB9XHJcblxyXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcclxuICB2YXIgdmFyeUhlYWRlcjtcclxuICB2YXIgcmVxdWVzdEhlYWRlcnMgPSBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpO1xyXG5cclxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICB2YXJ5SGVhZGVyID0gdmFyeUhlYWRlcnNbaV0udHJpbSgpO1xyXG5cclxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xyXG4gICAgICBjb250aW51ZTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gIT0gcmVxdWVzdEhlYWRlcnNbdmFyeUhlYWRlcl0pIHtcclxuICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gIH1cclxuICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xyXG4gIHZhciBpZCA9ICcnO1xyXG5cclxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XHJcbiAgICByZXR1cm4gaWQ7XHJcbiAgfVxyXG5cclxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KCcsJyk7XHJcbiAgdmFyIHZhcnlIZWFkZXI7XHJcblxyXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcclxuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XHJcblxyXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XHJcbiAgICAgIGNvbnRpbnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGlkICs9IHZhcnlIZWFkZXIgKyAnOiAnICsgKGVudHJ5UmVxdWVzdC5oZWFkZXJzW3ZhcnlIZWFkZXJdIHx8ICcnKSArICdcXG4nO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuSGVhZGVycyhoZWFkZXJzKSB7XHJcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xyXG5cclxuICBoZWFkZXJzLmZvckVhY2goZnVuY3Rpb24gKHZhbHVlLCBuYW1lKSB7XHJcbiAgICByZXR1cm5WYWxbbmFtZS50b0xvd2VyQ2FzZSgpXSA9IHZhbHVlO1xyXG4gIH0pO1xyXG5cclxuICByZXR1cm4gcmV0dXJuVmFsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnRyeVRvUmVzcG9uc2UoZW50cnkpIHtcclxuICB2YXIgZW50cnlSZXNwb25zZSA9IGVudHJ5LnJlc3BvbnNlO1xyXG4gIHJldHVybiBuZXcgUmVzcG9uc2UoZW50cnlSZXNwb25zZS5ib2R5LCB7XHJcbiAgICBzdGF0dXM6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzLFxyXG4gICAgc3RhdHVzVGV4dDogZW50cnlSZXNwb25zZS5zdGF0dXNUZXh0LFxyXG4gICAgaGVhZGVyczogZW50cnlSZXNwb25zZS5oZWFkZXJzXHJcbiAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgYm9keSkge1xyXG4gIHJldHVybiB7XHJcbiAgICBib2R5OiBib2R5LFxyXG4gICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXHJcbiAgICBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxyXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVzcG9uc2UuaGVhZGVycylcclxuICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnRyeVRvUmVxdWVzdChlbnRyeSkge1xyXG4gIHZhciBlbnRyeVJlcXVlc3QgPSBlbnRyeS5yZXF1ZXN0O1xyXG4gIHJldHVybiBuZXcgUmVxdWVzdChlbnRyeVJlcXVlc3QudXJsLCB7XHJcbiAgICBtb2RlOiBlbnRyeVJlcXVlc3QubW9kZSxcclxuICAgIGhlYWRlcnM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzLFxyXG4gICAgY3JlZGVudGlhbHM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzXHJcbiAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpIHtcclxuICByZXR1cm4ge1xyXG4gICAgdXJsOiByZXF1ZXN0LnVybCxcclxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcclxuICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmNyZWRlbnRpYWxzLFxyXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVxdWVzdC5oZWFkZXJzKVxyXG4gIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xyXG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xyXG4gICAgcmVxdWVzdCA9IG5ldyBSZXF1ZXN0KHJlcXVlc3QpO1xyXG4gIH1cclxuICByZXR1cm4gcmVxdWVzdDtcclxufVxyXG5cclxuZnVuY3Rpb24gQ2FjaGVEQigpIHtcclxuICB0aGlzLmRiID0gbmV3IElEQkhlbHBlcignY2FjaGUtcG9seWZpbGwnLCAxLCBmdW5jdGlvbihkYiwgb2xkVmVyc2lvbikge1xyXG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XHJcbiAgICAgIGNhc2UgMDpcclxuICAgICAgICB2YXIgbmFtZXNTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJywge1xyXG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbmFtZXNTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luJywgWydvcmlnaW4nLCAnYWRkZWQnXSk7XHJcblxyXG4gICAgICAgIHZhciBlbnRyeVN0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycsIHtcclxuICAgICAgICAgIGtleVBhdGg6IFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICd2YXJ5SUQnXVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAnYWRkZWQnXSk7XHJcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmxOb1NlYXJjaCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0VXJsTm9TZWFyY2gnLCAnYWRkZWQnXSk7XHJcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XHJcbiAgICB9XHJcbiAgfSk7XHJcbn1cclxuXHJcbnZhciBDYWNoZURCUHJvdG8gPSBDYWNoZURCLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlREJQcm90by5fZWFjaENhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcclxuICBJREJIZWxwZXIuaXRlcmF0ZShcclxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxyXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcclxuICApO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLl9lYWNoTWF0Y2ggPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrLCBwYXJhbXMpIHtcclxuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XHJcblxyXG4gIHZhciBpZ25vcmVTZWFyY2ggPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVTZWFyY2gpO1xyXG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xyXG4gIHZhciBpZ25vcmVWYXJ5ID0gQm9vbGVhbihwYXJhbXMuaWdub3JlVmFyeSk7XHJcbiAgdmFyIHByZWZpeE1hdGNoID0gQm9vbGVhbihwYXJhbXMucHJlZml4TWF0Y2gpO1xyXG5cclxuICBpZiAoIWlnbm9yZU1ldGhvZCAmJlxyXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0dFVCcgJiZcclxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xyXG4gICAgLy8gd2Ugb25seSBzdG9yZSBHRVQgcmVzcG9uc2VzIGF0IHRoZSBtb21lbnQsIHNvIG5vIG1hdGNoXHJcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbiAgfVxyXG5cclxuICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xyXG4gIHZhciByYW5nZTtcclxuICB2YXIgaW5kZXg7XHJcbiAgdmFyIGluZGV4TmFtZSA9ICdvcmlnaW4tY2FjaGVOYW1lLXVybCc7XHJcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcclxuXHJcbiAgdXJsVG9NYXRjaC5oYXNoID0gJyc7XHJcblxyXG4gIGlmIChpZ25vcmVTZWFyY2gpIHtcclxuICAgIHVybFRvTWF0Y2guc2VhcmNoID0gJyc7XHJcbiAgICBpbmRleE5hbWUgKz0gJ05vU2VhcmNoJztcclxuICB9XHJcblxyXG4gIC8vIHdvcmtpbmcgYXJvdW5kIGNocm9tZSBidWdzXHJcbiAgdXJsVG9NYXRjaCA9IHVybFRvTWF0Y2guaHJlZi5yZXBsYWNlKC8oXFw/fCN8XFw/IykkLywgJycpO1xyXG5cclxuICBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleChpbmRleE5hbWUpO1xyXG5cclxuICBpZiAocHJlZml4TWF0Y2gpIHtcclxuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NTUzNSksIEluZmluaXR5XSk7XHJcbiAgfVxyXG4gIGVsc2Uge1xyXG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIEluZmluaXR5XSk7XHJcbiAgfVxyXG5cclxuICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKHJhbmdlKSwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICB2YXIgdmFsdWUgPSBjdXJzb3IudmFsdWU7XHJcbiAgICBcclxuICAgIGlmIChpZ25vcmVWYXJ5IHx8IG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVzcG9uc2UpKSB7XHJcbiAgICAgIC8vIGl0J3MgZG93biB0byB0aGUgY2FsbGJhY2sgdG8gY2FsbCBjdXJzb3IuY29udGludWUoKVxyXG4gICAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcclxuICAgIH1cclxuICB9LCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLl9oYXNDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xyXG4gIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XHJcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgZG9uZUNhbGxiYWNrKCEhdmFsKTtcclxuICB9LCBlcnJDYWxsYmFjayk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uX2RlbGV0ZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaywgcGFyYW1zKSB7XHJcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xyXG5cclxuICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgIHJldHVyblZhbCA9IHRydWU7XHJcbiAgICBjdXJzb3IuZGVsZXRlKCk7XHJcbiAgICBjdXJzb3IuY29udGludWUoKTtcclxuICB9LCBmdW5jdGlvbigpIHtcclxuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgZG9uZUNhbGxiYWNrKHJldHVyblZhbCk7XHJcbiAgICB9XHJcbiAgfSwgZXJyQ2FsbGJhY2ssIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci5rZXkpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uYWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHZhciBtYXRjaGVzID0gW107XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcclxuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xyXG5cclxuICAgIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0pO1xyXG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaGVzID0gW107XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1Jlc3BvbnNlKTtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2g7XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcclxuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2hBY3Jvc3NDYWNoZXMgPSBmdW5jdGlvbihvcmlnaW4sIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaDtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihuYW1lc0N1cnNvcikge1xyXG4gICAgICB2YXIgY2FjaGVOYW1lID0gbmFtZXNDdXJzb3IudmFsdWUubmFtZTtcclxuXHJcbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uIGVhY2gocmVzcG9uc2VDdXJzb3IpIHtcclxuICAgICAgICBtYXRjaCA9IHJlc3BvbnNlQ3Vyc29yLnZhbHVlO1xyXG4gICAgICB9LCBmdW5jdGlvbiBkb25lKCkge1xyXG4gICAgICAgIGlmICghbWF0Y2gpIHtcclxuICAgICAgICAgIG5hbWVzQ3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9LCB1bmRlZmluZWQsIHBhcmFtcyk7XHJcbiAgICB9LmJpbmQodGhpcykpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uY2FjaGVOYW1lcyA9IGZ1bmN0aW9uKG9yaWdpbikge1xyXG4gIHZhciBuYW1lcyA9IFtdO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlLm5hbWUpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG5hbWVzO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgcmV0dXJuVmFsO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMsIGZ1bmN0aW9uKHYpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdjtcclxuICAgIH0pO1xyXG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiByZXR1cm5WYWw7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ub3BlbkNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgICBpZiAodmFsKSB7IHJldHVybjsgfVxyXG4gICAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xyXG4gICAgICBzdG9yZS5hZGQoe1xyXG4gICAgICAgIG9yaWdpbjogb3JpZ2luLFxyXG4gICAgICAgIG5hbWU6IGNhY2hlTmFtZSxcclxuICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uaGFzQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHZhciByZXR1cm5WYWw7XHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdmFsO1xyXG4gICAgfSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgcmV0dXJuIHJldHVyblZhbDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XHJcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcclxuICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLm9ubHkoW29yaWdpbiwgY2FjaGVOYW1lXSkpLFxyXG4gICAgICBkZWxcclxuICAgICk7XHJcblxyXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXHJcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSxcclxuICAgICAgZGVsXHJcbiAgICApO1xyXG5cclxuICAgIGZ1bmN0aW9uIGRlbChjdXJzb3IpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcclxuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH1cclxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xyXG4gIC8vIGl0ZW1zIGlzIFtbcmVxdWVzdCwgcmVzcG9uc2VdLCBbcmVxdWVzdCwgcmVzcG9uc2VdLCDigKZdXHJcbiAgdmFyIGl0ZW07XHJcblxyXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaXRlbXMubGVuZ3RoOyBpKyspIHtcclxuICAgIGl0ZW1zW2ldWzBdID0gY2FzdFRvUmVxdWVzdChpdGVtc1tpXVswXSk7XHJcblxyXG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdPbmx5IEdFVCByZXF1ZXN0cyBhcmUgc3VwcG9ydGVkJykpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChpdGVtc1tpXVsxXS50eXBlID09ICdvcGFxdWUnKSB7XHJcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoXCJUaGUgcG9seWZpbGwgZG9lc24ndCBzdXBwb3J0IG9wYXF1ZSByZXNwb25zZXMgKGZyb20gY3Jvc3Mtb3JpZ2luIG5vLWNvcnMgcmVxdWVzdHMpXCIpKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcclxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XHJcbiAgICAgIGlmIChpdGVtc1tpXVswXS51cmwgPT0gaXRlbXNbal1bMF0udXJsICYmIG1hdGNoZXNWYXJ5KGl0ZW1zW2pdWzBdLCBpdGVtc1tpXVswXSwgaXRlbXNbaV1bMV0pKSB7XHJcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gUHJvbWlzZS5hbGwoXHJcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xyXG4gICAgICByZXR1cm4gaXRlbVsxXS5ibG9iKCk7XHJcbiAgICB9KVxyXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xyXG4gICAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xyXG4gICAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKGhhc0NhY2hlKSB7XHJcbiAgICAgICAgaWYgKCFoYXNDYWNoZSkge1xyXG4gICAgICAgICAgdGhyb3cgRXJyb3IoXCJDYWNoZSBvZiB0aGF0IG5hbWUgZG9lcyBub3QgZXhpc3RcIik7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0sIGkpIHtcclxuICAgICAgICAgIHZhciByZXF1ZXN0ID0gaXRlbVswXTtcclxuICAgICAgICAgIHZhciByZXNwb25zZSA9IGl0ZW1bMV07XHJcbiAgICAgICAgICB2YXIgcmVxdWVzdEVudHJ5ID0gcmVxdWVzdFRvRW50cnkocmVxdWVzdCk7XHJcbiAgICAgICAgICB2YXIgcmVzcG9uc2VFbnRyeSA9IHJlc3BvbnNlVG9FbnRyeShyZXNwb25zZSwgcmVzcG9uc2VCb2RpZXNbaV0pO1xyXG5cclxuICAgICAgICAgIHZhciByZXF1ZXN0VXJsTm9TZWFyY2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcclxuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaC5zZWFyY2ggPSAnJztcclxuICAgICAgICAgIC8vIHdvcmtpbmcgYXJvdW5kIENocm9tZSBidWdcclxuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaCA9IHJlcXVlc3RVcmxOb1NlYXJjaC5ocmVmLnJlcGxhY2UoL1xcPyQvLCAnJyk7XHJcblxyXG4gICAgICAgICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oKSB7XHJcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xyXG4gICAgICAgICAgICAgIG9yaWdpbjogb3JpZ2luLFxyXG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogY2FjaGVOYW1lLFxyXG4gICAgICAgICAgICAgIHJlcXVlc3Q6IHJlcXVlc3RFbnRyeSxcclxuICAgICAgICAgICAgICByZXNwb25zZTogcmVzcG9uc2VFbnRyeSxcclxuICAgICAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2g6IHJlcXVlc3RVcmxOb1NlYXJjaCxcclxuICAgICAgICAgICAgICB2YXJ5SUQ6IGNyZWF0ZVZhcnlJRChyZXF1ZXN0RW50cnksIHJlc3BvbnNlRW50cnkpLFxyXG4gICAgICAgICAgICAgIGFkZGVkOiBEYXRlLm5vdygpXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZURCKCk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcclxudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xyXG5cclxuZnVuY3Rpb24gQ2FjaGVTdG9yYWdlKCkge1xyXG4gIHRoaXMuX29yaWdpbiA9IGxvY2F0aW9uLm9yaWdpbjtcclxufVxyXG5cclxudmFyIENhY2hlU3RvcmFnZVByb3RvID0gQ2FjaGVTdG9yYWdlLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLl92ZW5kQ2FjaGUgPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XHJcbiAgY2FjaGUuX25hbWUgPSBuYW1lO1xyXG4gIGNhY2hlLl9vcmlnaW4gPSB0aGlzLl9vcmlnaW47XHJcbiAgcmV0dXJuIGNhY2hlO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyh0aGlzLl9vcmlnaW4sIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5oYXMgPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIuaGFzQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLm9wZW4gPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIub3BlbkNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XHJcbiAgfS5iaW5kKHRoaXMpKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICByZXR1cm4gY2FjaGVEQi5kZWxldGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xyXG4gIHJldHVybiBjYWNoZURCLmNhY2hlTmFtZXModGhpcy5fb3JpZ2luKTtcclxufTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlU3RvcmFnZSgpO1xyXG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XHJcbiAgdmFyIHJlcXVlc3QgPSAoc2VsZi5faW5kZXhlZERCIHx8IHNlbGYuaW5kZXhlZERCKS5vcGVuKG5hbWUsIHZlcnNpb24pO1xyXG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xyXG4gIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gZnVuY3Rpb24oZXZlbnQpIHtcclxuICAgIHVwZ3JhZGVDYWxsYmFjayhyZXF1ZXN0LnJlc3VsdCwgZXZlbnQub2xkVmVyc2lvbik7XHJcbiAgfTtcclxufVxyXG5cclxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdfaW5kZXhlZERCJyBpbiBzZWxmIHx8ICdpbmRleGVkREInIGluIHNlbGY7XHJcblxyXG5JREJIZWxwZXIucHJvbWlzaWZ5ID0gZnVuY3Rpb24ob2JqKSB7XHJcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xyXG4gICAgSURCSGVscGVyLmNhbGxiYWNraWZ5KG9iaiwgcmVzb2x2ZSwgcmVqZWN0KTtcclxuICB9KTtcclxufTtcclxuXHJcbklEQkhlbHBlci5jYWxsYmFja2lmeSA9IGZ1bmN0aW9uKG9iaiwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xyXG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xyXG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xyXG4gICAgICBkb25lQ2FsbGJhY2sob2JqLnJlc3VsdCk7XHJcbiAgICB9XHJcbiAgICB1bmxpc3RlbigpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XHJcbiAgICBpZiAoZXJyQ2FsbGJhY2spIHtcclxuICAgICAgZXJyQ2FsbGJhY2sob2JqLmVycm9yKTtcclxuICAgIH1cclxuICAgIHVubGlzdGVuKCk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHVubGlzdGVuKCkge1xyXG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NvbXBsZXRlJywgb25zdWNjZXNzKTtcclxuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdzdWNjZXNzJywgb25zdWNjZXNzKTtcclxuICAgIG9iai5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xyXG4gICAgb2JqLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0Jywgb25lcnJvcik7XHJcbiAgfVxyXG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdjb21wbGV0ZScsIG9uc3VjY2Vzcyk7XHJcbiAgb2JqLmFkZEV2ZW50TGlzdGVuZXIoJ3N1Y2Nlc3MnLCBvbnN1Y2Nlc3MpO1xyXG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uZXJyb3IpO1xyXG4gIG9iai5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uZXJyb3IpO1xyXG59O1xyXG5cclxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xyXG4gIHZhciBvbGRDdXJzb3JDb250aW51ZTtcclxuXHJcbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XHJcbiAgICB0aGlzLl9jb250aW51aW5nID0gdHJ1ZTtcclxuICAgIHJldHVybiBvbGRDdXJzb3JDb250aW51ZS5jYWxsKHRoaXMpO1xyXG4gIH1cclxuXHJcbiAgY3Vyc29yUmVxdWVzdC5vbnN1Y2Nlc3MgPSBmdW5jdGlvbigpIHtcclxuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcclxuXHJcbiAgICBpZiAoIWN1cnNvcikge1xyXG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XHJcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcclxuICAgICAgb2xkQ3Vyc29yQ29udGludWUgPSBjdXJzb3IuY29udGludWU7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSA9IGN1cnNvckNvbnRpbnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xyXG5cclxuICAgIGlmICghY3Vyc29yLl9jb250aW51aW5nKSB7XHJcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgICBkb25lQ2FsbGJhY2soKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH07XHJcblxyXG4gIGN1cnNvclJlcXVlc3Qub25lcnJvciA9IGZ1bmN0aW9uKCkge1xyXG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcclxuICAgICAgZXJyb3JDYWxsYmFjayhjdXJzb3JSZXF1ZXN0LmVycm9yKTtcclxuICAgIH1cclxuICB9O1xyXG59O1xyXG5cclxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcclxuXHJcbklEQkhlbHBlclByb3RvLnRyYW5zYWN0aW9uID0gZnVuY3Rpb24oc3RvcmVzLCBjYWxsYmFjaywgb3B0cykge1xyXG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xyXG5cclxuICByZXR1cm4gdGhpcy5yZWFkeS50aGVuKGZ1bmN0aW9uKGRiKSB7XHJcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xyXG5cclxuICAgIHZhciB0eCA9IGRiLnRyYW5zYWN0aW9uKHN0b3JlcywgbW9kZSk7XHJcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xyXG4gICAgcmV0dXJuIElEQkhlbHBlci5wcm9taXNpZnkodHgpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBJREJIZWxwZXI7Il19
