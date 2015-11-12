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
  return new Response(atob(entryResponse.body), {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: btoa(body),
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
    url: request.url.toString(),
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
  }
  function onerror(event) {
    if (errCallback) {
      errCallback(obj.error);
    }
  }
  obj.oncomplete = onsuccess;
  obj.onsuccess = onsuccess;
  obj.onerror = onerror;
  obj.onabort = onerror;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlc1xcYnJvd3NlcmlmeVxcbm9kZV9tb2R1bGVzXFxicm93c2VyLXBhY2tcXF9wcmVsdWRlLmpzIiwiLi9idWlsZC9pbmRleC5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZS5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZWRiLmpzIiwiQzovVXNlcnMvQ0NhdmFsaWVyL0RvY3VtZW50cy9HaXRIdWIvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlcy5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9pZGJoZWxwZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2YUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJpZighd2luZG93LmNhY2hlcykgd2luZG93LmNhY2hlcyA9IHJlcXVpcmUoJy4uL2xpYi9jYWNoZXMuanMnKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xyXG5cclxuZnVuY3Rpb24gQ2FjaGUoKSB7XHJcbiAgdGhpcy5fbmFtZSA9ICcnO1xyXG4gIHRoaXMuX29yaWdpbiA9ICcnO1xyXG59XHJcblxyXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5hZGRBbGwgPSBmdW5jdGlvbihyZXF1ZXN0cykge1xyXG4gIHJldHVybiBQcm9taXNlLmFsbChcclxuICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XHJcbiAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcclxuICAgIH0pXHJcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xyXG4gICAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVzcG9uc2VzLm1hcChmdW5jdGlvbihyZXNwb25zZSwgaSkge1xyXG4gICAgICByZXR1cm4gW3JlcXVlc3RzW2ldLCByZXNwb25zZV07XHJcbiAgICB9KSk7XHJcbiAgfS5iaW5kKHRoaXMpKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8uYWRkID0gZnVuY3Rpb24ocmVxdWVzdCkge1xyXG4gIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5wdXQgPSBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSkge1xyXG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XHJcbiAgICB0aHJvdyBUeXBlRXJyb3IoXCJJbmNvcnJlY3QgcmVzcG9uc2UgdHlwZVwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIFtbcmVxdWVzdCwgcmVzcG9uc2VdXSk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZSh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmtleXMgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICBpZiAocmVxdWVzdCkge1xyXG4gICAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbiAgfVxyXG4gIGVsc2Uge1xyXG4gICAgcmV0dXJuIGNhY2hlREIuYWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lKTtcclxuICB9XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENhY2hlO1xyXG4iLCJ2YXIgSURCSGVscGVyID0gcmVxdWlyZSgnLi9pZGJoZWxwZXInKTtcclxuXHJcbmZ1bmN0aW9uIG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xyXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuXHJcbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xyXG4gIHZhciB2YXJ5SGVhZGVyO1xyXG4gIHZhciByZXF1ZXN0SGVhZGVycyA9IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycyk7XHJcblxyXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcclxuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XHJcblxyXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XHJcbiAgICAgIGNvbnRpbnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjcmVhdGVWYXJ5SUQoZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XHJcbiAgdmFyIGlkID0gJyc7XHJcblxyXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcclxuICAgIHJldHVybiBpZDtcclxuICB9XHJcblxyXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcclxuICB2YXIgdmFyeUhlYWRlcjtcclxuXHJcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xyXG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcclxuXHJcbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcclxuICAgICAgY29udGludWU7XHJcbiAgICB9XHJcblxyXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gaWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcclxuICB2YXIgcmV0dXJuVmFsID0ge307XHJcblxyXG4gIGhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbiAodmFsdWUsIG5hbWUpIHtcclxuICAgIHJldHVyblZhbFtuYW1lLnRvTG93ZXJDYXNlKCldID0gdmFsdWU7XHJcbiAgfSk7XHJcblxyXG4gIHJldHVybiByZXR1cm5WYWw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xyXG4gIHZhciBlbnRyeVJlc3BvbnNlID0gZW50cnkucmVzcG9uc2U7XHJcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShhdG9iKGVudHJ5UmVzcG9uc2UuYm9keSksIHtcclxuICAgIHN0YXR1czogZW50cnlSZXNwb25zZS5zdGF0dXMsXHJcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXHJcbiAgICBoZWFkZXJzOiBlbnRyeVJlc3BvbnNlLmhlYWRlcnNcclxuICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCBib2R5KSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIGJvZHk6IGJ0b2EoYm9keSksXHJcbiAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cyxcclxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXHJcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXNwb25zZS5oZWFkZXJzKVxyXG4gIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVudHJ5VG9SZXF1ZXN0KGVudHJ5KSB7XHJcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XHJcbiAgcmV0dXJuIG5ldyBSZXF1ZXN0KGVudHJ5UmVxdWVzdC51cmwsIHtcclxuICAgIG1vZGU6IGVudHJ5UmVxdWVzdC5tb2RlLFxyXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXHJcbiAgICBjcmVkZW50aWFsczogZW50cnlSZXF1ZXN0LmhlYWRlcnNcclxuICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWVzdFRvRW50cnkocmVxdWVzdCkge1xyXG4gIHJldHVybiB7XHJcbiAgICB1cmw6IHJlcXVlc3QudXJsLnRvU3RyaW5nKCksXHJcbiAgICBtb2RlOiByZXF1ZXN0Lm1vZGUsXHJcbiAgICBjcmVkZW50aWFsczogcmVxdWVzdC5jcmVkZW50aWFscyxcclxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycylcclxuICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpIHtcclxuICBpZiAoIShyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkpIHtcclxuICAgIHJlcXVlc3QgPSBuZXcgUmVxdWVzdChyZXF1ZXN0KTtcclxuICB9XHJcbiAgcmV0dXJuIHJlcXVlc3Q7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIENhY2hlREIoKSB7XHJcbiAgdGhpcy5kYiA9IG5ldyBJREJIZWxwZXIoJ2NhY2hlLXBvbHlmaWxsJywgMSwgZnVuY3Rpb24oZGIsIG9sZFZlcnNpb24pIHtcclxuICAgIHN3aXRjaCAob2xkVmVyc2lvbikge1xyXG4gICAgICBjYXNlIDA6XHJcbiAgICAgICAgdmFyIG5hbWVzU3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVOYW1lcycsIHtcclxuICAgICAgICAgIGtleVBhdGg6IFsnb3JpZ2luJywgJ25hbWUnXVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG5hbWVzU3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbicsIFsnb3JpZ2luJywgJ2FkZGVkJ10pO1xyXG5cclxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XHJcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAndmFyeUlEJ11cclxuICAgICAgICB9KTtcclxuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ2FkZGVkJ10pO1xyXG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsTm9TZWFyY2gnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdFVybE5vU2VhcmNoJywgJ2FkZGVkJ10pO1xyXG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUtdXJsJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ2FkZGVkJ10pO1xyXG4gICAgfVxyXG4gIH0pO1xyXG59XHJcblxyXG52YXIgQ2FjaGVEQlByb3RvID0gQ2FjaGVEQi5wcm90b3R5cGU7XHJcblxyXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XHJcbiAgSURCSGVscGVyLml0ZXJhdGUoXHJcbiAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLmluZGV4KCdvcmlnaW4nKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIDBdLCBbb3JpZ2luLCBJbmZpbml0eV0pKSxcclxuICAgIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrXHJcbiAgKTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5fZWFjaE1hdGNoID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaywgcGFyYW1zKSB7XHJcbiAgcGFyYW1zID0gcGFyYW1zIHx8IHt9O1xyXG5cclxuICB2YXIgaWdub3JlU2VhcmNoID0gQm9vbGVhbihwYXJhbXMuaWdub3JlU2VhcmNoKTtcclxuICB2YXIgaWdub3JlTWV0aG9kID0gQm9vbGVhbihwYXJhbXMuaWdub3JlTWV0aG9kKTtcclxuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xyXG4gIHZhciBwcmVmaXhNYXRjaCA9IEJvb2xlYW4ocGFyYW1zLnByZWZpeE1hdGNoKTtcclxuXHJcbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcclxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdHRVQnICYmXHJcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnSEVBRCcpIHtcclxuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxyXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xyXG4gIH1cclxuXHJcbiAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcclxuICB2YXIgcmFuZ2U7XHJcbiAgdmFyIGluZGV4O1xyXG4gIHZhciBpbmRleE5hbWUgPSAnb3JpZ2luLWNhY2hlTmFtZS11cmwnO1xyXG4gIHZhciB1cmxUb01hdGNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XHJcblxyXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xyXG5cclxuICBpZiAoaWdub3JlU2VhcmNoKSB7XHJcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xyXG4gICAgaW5kZXhOYW1lICs9ICdOb1NlYXJjaCc7XHJcbiAgfVxyXG5cclxuICAvLyB3b3JraW5nIGFyb3VuZCBjaHJvbWUgYnVnc1xyXG4gIHVybFRvTWF0Y2ggPSB1cmxUb01hdGNoLmhyZWYucmVwbGFjZSgvKFxcP3wjfFxcPyMpJC8sICcnKTtcclxuXHJcbiAgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoaW5kZXhOYW1lKTtcclxuXHJcbiAgaWYgKHByZWZpeE1hdGNoKSB7XHJcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjU1MzUpLCBJbmZpbml0eV0pO1xyXG4gIH1cclxuICBlbHNlIHtcclxuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCBJbmZpbml0eV0pO1xyXG4gIH1cclxuXHJcbiAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihyYW5nZSksIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgdmFyIHZhbHVlID0gY3Vyc29yLnZhbHVlO1xyXG4gICAgXHJcbiAgICBpZiAoaWdub3JlVmFyeSB8fCBtYXRjaGVzVmFyeShyZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlc3BvbnNlKSkge1xyXG4gICAgICAvLyBpdCdzIGRvd24gdG8gdGhlIGNhbGxiYWNrIHRvIGNhbGwgY3Vyc29yLmNvbnRpbnVlKClcclxuICAgICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XHJcbiAgICB9XHJcbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcclxuICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xyXG4gIHJldHVybiBJREJIZWxwZXIuY2FsbGJhY2tpZnkoc3RvcmUuZ2V0KFtvcmlnaW4sIGNhY2hlTmFtZV0pLCBmdW5jdGlvbih2YWwpIHtcclxuICAgIGRvbmVDYWxsYmFjayghIXZhbCk7XHJcbiAgfSwgZXJyQ2FsbGJhY2spO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLl9kZWxldGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2ssIHBhcmFtcykge1xyXG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcclxuXHJcbiAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICByZXR1cm5WYWwgPSB0cnVlO1xyXG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xyXG4gICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgfSwgZnVuY3Rpb24oKSB7XHJcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XHJcbiAgICAgIGRvbmVDYWxsYmFjayhyZXR1cm5WYWwpO1xyXG4gICAgfVxyXG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgdmFyIG1hdGNoZXMgPSBbXTtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3Iua2V5KTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcclxuICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XHJcbiAgICB2YXIgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKTtcclxuXHJcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9KTtcclxuICB9KS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5tYXRjaEFsbCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXNwb25zZSk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgdmFyIG1hdGNoO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbWF0Y2ggPSBjdXJzb3IudmFsdWU7XHJcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm1hdGNoQWNyb3NzQ2FjaGVzID0gZnVuY3Rpb24ob3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2g7XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24obmFtZXNDdXJzb3IpIHtcclxuICAgICAgdmFyIGNhY2hlTmFtZSA9IG5hbWVzQ3Vyc29yLnZhbHVlLm5hbWU7XHJcblxyXG4gICAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbiBlYWNoKHJlc3BvbnNlQ3Vyc29yKSB7XHJcbiAgICAgICAgbWF0Y2ggPSByZXNwb25zZUN1cnNvci52YWx1ZTtcclxuICAgICAgfSwgZnVuY3Rpb24gZG9uZSgpIHtcclxuICAgICAgICBpZiAoIW1hdGNoKSB7XHJcbiAgICAgICAgICBuYW1lc0N1cnNvci5jb250aW51ZSgpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gICAgfS5iaW5kKHRoaXMpKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmNhY2hlTmFtZXMgPSBmdW5jdGlvbihvcmlnaW4pIHtcclxuICB2YXIgbmFtZXMgPSBbXTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBuYW1lcy5wdXNoKGN1cnNvci52YWx1ZS5uYW1lKTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9LmJpbmQodGhpcykpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBuYW1lcztcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5kZWxldGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgdmFyIHJldHVyblZhbDtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zLCBmdW5jdGlvbih2KSB7XHJcbiAgICAgIHJldHVyblZhbCA9IHY7XHJcbiAgICB9KTtcclxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm9wZW5DYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcclxuICAgICAgaWYgKHZhbCkgeyByZXR1cm47IH1cclxuICAgICAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcclxuICAgICAgc3RvcmUuYWRkKHtcclxuICAgICAgICBvcmlnaW46IG9yaWdpbixcclxuICAgICAgICBuYW1lOiBjYWNoZU5hbWUsXHJcbiAgICAgICAgYWRkZWQ6IERhdGUubm93KClcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcclxuICB2YXIgcmV0dXJuVmFsO1xyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XHJcbiAgICAgIHJldHVyblZhbCA9IHZhbDtcclxuICAgIH0pO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbih2YWwpIHtcclxuICAgIHJldHVybiByZXR1cm5WYWw7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uZGVsZXRlQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xyXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXHJcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5vbmx5KFtvcmlnaW4sIGNhY2hlTmFtZV0pKSxcclxuICAgICAgZGVsXHJcbiAgICApO1xyXG5cclxuICAgIElEQkhlbHBlci5pdGVyYXRlKFxyXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksXHJcbiAgICAgIGRlbFxyXG4gICAgKTtcclxuXHJcbiAgICBmdW5jdGlvbiBkZWwoY3Vyc29yKSB7XHJcbiAgICAgIHJldHVyblZhbCA9IHRydWU7XHJcbiAgICAgIGN1cnNvci5kZWxldGUoKTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9XHJcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIHJldHVyblZhbDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5wdXQgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgaXRlbXMpIHtcclxuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxyXG4gIHZhciBpdGVtO1xyXG5cclxuICBmb3IgKHZhciBpID0gMDsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBpdGVtc1tpXVswXSA9IGNhc3RUb1JlcXVlc3QoaXRlbXNbaV1bMF0pO1xyXG5cclxuICAgIGlmIChpdGVtc1tpXVswXS5tZXRob2QgIT0gJ0dFVCcpIHtcclxuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoaXRlbXNbaV1bMV0udHlwZSA9PSAnb3BhcXVlJykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKFwiVGhlIHBvbHlmaWxsIGRvZXNuJ3Qgc3VwcG9ydCBvcGFxdWUgcmVzcG9uc2VzIChmcm9tIGNyb3NzLW9yaWdpbiBuby1jb3JzIHJlcXVlc3RzKVwiKSk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gZW5zdXJlIGVhY2ggZW50cnkgYmVpbmcgcHV0IHdvbid0IG92ZXJ3cml0ZSBlYXJsaWVyIGVudHJpZXMgYmVpbmcgcHV0XHJcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xyXG4gICAgICBpZiAoaXRlbXNbaV1bMF0udXJsID09IGl0ZW1zW2pdWzBdLnVybCAmJiBtYXRjaGVzVmFyeShpdGVtc1tqXVswXSwgaXRlbXNbaV1bMF0sIGl0ZW1zW2ldWzFdKSkge1xyXG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoJ1B1dHMgd291bGQgb3ZlcndyaXRlIGVhY2hvdGhlcicpKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxyXG4gICAgaXRlbXMubWFwKGZ1bmN0aW9uKGl0ZW0pIHtcclxuICAgICAgcmV0dXJuIGl0ZW1bMV0uYmxvYigpO1xyXG4gICAgfSlcclxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VCb2RpZXMpIHtcclxuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcclxuICAgICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbihoYXNDYWNoZSkge1xyXG4gICAgICAgIGlmICghaGFzQ2FjaGUpIHtcclxuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XHJcbiAgICAgICAgICB2YXIgcmVxdWVzdCA9IGl0ZW1bMF07XHJcbiAgICAgICAgICB2YXIgcmVzcG9uc2UgPSBpdGVtWzFdO1xyXG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xyXG4gICAgICAgICAgdmFyIHJlc3BvbnNlRW50cnkgPSByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIHJlc3BvbnNlQm9kaWVzW2ldKTtcclxuXHJcbiAgICAgICAgICB2YXIgcmVxdWVzdFVybE5vU2VhcmNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XHJcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2guc2VhcmNoID0gJyc7XHJcbiAgICAgICAgICAvLyB3b3JraW5nIGFyb3VuZCBDaHJvbWUgYnVnXHJcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2ggPSByZXF1ZXN0VXJsTm9TZWFyY2guaHJlZi5yZXBsYWNlKC9cXD8kLywgJycpO1xyXG5cclxuICAgICAgICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKCkge1xyXG4gICAgICAgICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuYWRkKHtcclxuICAgICAgICAgICAgICBvcmlnaW46IG9yaWdpbixcclxuICAgICAgICAgICAgICBjYWNoZU5hbWU6IGNhY2hlTmFtZSxcclxuICAgICAgICAgICAgICByZXF1ZXN0OiByZXF1ZXN0RW50cnksXHJcbiAgICAgICAgICAgICAgcmVzcG9uc2U6IHJlc3BvbnNlRW50cnksXHJcbiAgICAgICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoOiByZXF1ZXN0VXJsTm9TZWFyY2gsXHJcbiAgICAgICAgICAgICAgdmFyeUlEOiBjcmVhdGVWYXJ5SUQocmVxdWVzdEVudHJ5LCByZXNwb25zZUVudHJ5KSxcclxuICAgICAgICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH0pO1xyXG5cclxuICAgICAgICB9LmJpbmQodGhpcykpO1xyXG4gICAgICB9LmJpbmQodGhpcykpO1xyXG4gICAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gIH0pO1xyXG59O1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVEQigpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XHJcbnZhciBDYWNoZSA9IHJlcXVpcmUoJy4vY2FjaGUnKTtcclxuXHJcbmZ1bmN0aW9uIENhY2hlU3RvcmFnZSgpIHtcclxuICB0aGlzLl9vcmlnaW4gPSBsb2NhdGlvbi5vcmlnaW47XHJcbn1cclxuXHJcbnZhciBDYWNoZVN0b3JhZ2VQcm90byA9IENhY2hlU3RvcmFnZS5wcm90b3R5cGU7XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5fdmVuZENhY2hlID0gZnVuY3Rpb24obmFtZSkge1xyXG4gIHZhciBjYWNoZSA9IG5ldyBDYWNoZSgpO1xyXG4gIGNhY2hlLl9uYW1lID0gbmFtZTtcclxuICBjYWNoZS5fb3JpZ2luID0gdGhpcy5fb3JpZ2luO1xyXG4gIHJldHVybiBjYWNoZTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBY3Jvc3NDYWNoZXModGhpcy5fb3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8uaGFzID0gZnVuY3Rpb24obmFtZSkge1xyXG4gIHJldHVybiBjYWNoZURCLmhhc0NhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5vcGVuID0gZnVuY3Rpb24obmFtZSkge1xyXG4gIHJldHVybiBjYWNoZURCLm9wZW5DYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gdGhpcy5fdmVuZENhY2hlKG5hbWUpO1xyXG4gIH0uYmluZCh0aGlzKSk7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5kZWxldGUgPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLmtleXMgPSBmdW5jdGlvbigpIHtcclxuICByZXR1cm4gY2FjaGVEQi5jYWNoZU5hbWVzKHRoaXMuX29yaWdpbik7XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZVN0b3JhZ2UoKTtcclxuIiwiZnVuY3Rpb24gSURCSGVscGVyKG5hbWUsIHZlcnNpb24sIHVwZ3JhZGVDYWxsYmFjaykge1xyXG4gIHZhciByZXF1ZXN0ID0gKHNlbGYuX2luZGV4ZWREQiB8fCBzZWxmLmluZGV4ZWREQikub3BlbihuYW1lLCB2ZXJzaW9uKTtcclxuICB0aGlzLnJlYWR5ID0gSURCSGVscGVyLnByb21pc2lmeShyZXF1ZXN0KTtcclxuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XHJcbiAgICB1cGdyYWRlQ2FsbGJhY2socmVxdWVzdC5yZXN1bHQsIGV2ZW50Lm9sZFZlcnNpb24pO1xyXG4gIH07XHJcbn1cclxuXHJcbklEQkhlbHBlci5zdXBwb3J0ZWQgPSAnX2luZGV4ZWREQicgaW4gc2VsZiB8fCAnaW5kZXhlZERCJyBpbiBzZWxmO1xyXG5cclxuSURCSGVscGVyLnByb21pc2lmeSA9IGZ1bmN0aW9uKG9iaikge1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcclxuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5JREJIZWxwZXIuY2FsbGJhY2tpZnkgPSBmdW5jdGlvbihvYmosIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcclxuICBmdW5jdGlvbiBvbnN1Y2Nlc3MoZXZlbnQpIHtcclxuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgZG9uZUNhbGxiYWNrKG9iai5yZXN1bHQpO1xyXG4gICAgfVxyXG4gIH1cclxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XHJcbiAgICBpZiAoZXJyQ2FsbGJhY2spIHtcclxuICAgICAgZXJyQ2FsbGJhY2sob2JqLmVycm9yKTtcclxuICAgIH1cclxuICB9XHJcbiAgb2JqLm9uY29tcGxldGUgPSBvbnN1Y2Nlc3M7XHJcbiAgb2JqLm9uc3VjY2VzcyA9IG9uc3VjY2VzcztcclxuICBvYmoub25lcnJvciA9IG9uZXJyb3I7XHJcbiAgb2JqLm9uYWJvcnQgPSBvbmVycm9yO1xyXG59O1xyXG5cclxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xyXG4gIHZhciBvbGRDdXJzb3JDb250aW51ZTtcclxuXHJcbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XHJcbiAgICB0aGlzLl9jb250aW51aW5nID0gdHJ1ZTtcclxuICAgIHJldHVybiBvbGRDdXJzb3JDb250aW51ZS5jYWxsKHRoaXMpO1xyXG4gIH1cclxuXHJcbiAgY3Vyc29yUmVxdWVzdC5vbnN1Y2Nlc3MgPSBmdW5jdGlvbigpIHtcclxuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcclxuXHJcbiAgICBpZiAoIWN1cnNvcikge1xyXG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XHJcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcclxuICAgICAgb2xkQ3Vyc29yQ29udGludWUgPSBjdXJzb3IuY29udGludWU7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSA9IGN1cnNvckNvbnRpbnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xyXG5cclxuICAgIGlmICghY3Vyc29yLl9jb250aW51aW5nKSB7XHJcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgICBkb25lQ2FsbGJhY2soKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH07XHJcblxyXG4gIGN1cnNvclJlcXVlc3Qub25lcnJvciA9IGZ1bmN0aW9uKCkge1xyXG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcclxuICAgICAgZXJyb3JDYWxsYmFjayhjdXJzb3JSZXF1ZXN0LmVycm9yKTtcclxuICAgIH1cclxuICB9O1xyXG59O1xyXG5cclxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcclxuXHJcbklEQkhlbHBlclByb3RvLnRyYW5zYWN0aW9uID0gZnVuY3Rpb24oc3RvcmVzLCBjYWxsYmFjaywgb3B0cykge1xyXG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xyXG5cclxuICByZXR1cm4gdGhpcy5yZWFkeS50aGVuKGZ1bmN0aW9uKGRiKSB7XHJcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xyXG5cclxuICAgIHZhciB0eCA9IGRiLnRyYW5zYWN0aW9uKHN0b3JlcywgbW9kZSk7XHJcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xyXG4gICAgcmV0dXJuIElEQkhlbHBlci5wcm9taXNpZnkodHgpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBJREJIZWxwZXI7Il19
