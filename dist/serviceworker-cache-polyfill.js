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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlc1xcYnJvd3NlcmlmeVxcbm9kZV9tb2R1bGVzXFxicm93c2VyLXBhY2tcXF9wcmVsdWRlLmpzIiwiLi9idWlsZC9pbmRleC5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZS5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZWRiLmpzIiwiQzovVXNlcnMvQ0NhdmFsaWVyL0RvY3VtZW50cy9HaXRIdWIvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlcy5qcyIsIkM6L1VzZXJzL0NDYXZhbGllci9Eb2N1bWVudHMvR2l0SHViL2NhY2hlLXBvbHlmaWxsL2xpYi9pZGJoZWxwZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2YUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJpZighd2luZG93LmNhY2hlcykgd2luZG93LmNhY2hlcyA9IHJlcXVpcmUoJy4uL2xpYi9jYWNoZXMuanMnKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xyXG5cclxuZnVuY3Rpb24gQ2FjaGUoKSB7XHJcbiAgdGhpcy5fbmFtZSA9ICcnO1xyXG4gIHRoaXMuX29yaWdpbiA9ICcnO1xyXG59XHJcblxyXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGwodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5hZGRBbGwgPSBmdW5jdGlvbihyZXF1ZXN0cykge1xyXG4gIHJldHVybiBQcm9taXNlLmFsbChcclxuICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XHJcbiAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcclxuICAgIH0pXHJcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xyXG4gICAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVzcG9uc2VzLm1hcChmdW5jdGlvbihyZXNwb25zZSwgaSkge1xyXG4gICAgICByZXR1cm4gW3JlcXVlc3RzW2ldLCByZXNwb25zZV07XHJcbiAgICB9KSk7XHJcbiAgfS5iaW5kKHRoaXMpKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8uYWRkID0gZnVuY3Rpb24ocmVxdWVzdCkge1xyXG4gIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5wdXQgPSBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSkge1xyXG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XHJcbiAgICB0aHJvdyBUeXBlRXJyb3IoXCJJbmNvcnJlY3QgcmVzcG9uc2UgdHlwZVwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIFtbcmVxdWVzdCwgcmVzcG9uc2VdXSk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZSh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmtleXMgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICBpZiAocmVxdWVzdCkge1xyXG4gICAgcmV0dXJuIGNhY2hlREIubWF0Y2hBbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbiAgfVxyXG4gIGVsc2Uge1xyXG4gICAgcmV0dXJuIGNhY2hlREIuYWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lKTtcclxuICB9XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IENhY2hlO1xyXG4iLCJ2YXIgSURCSGVscGVyID0gcmVxdWlyZSgnLi9pZGJoZWxwZXInKTtcclxuXHJcbmZ1bmN0aW9uIG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xyXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuXHJcbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xyXG4gIHZhciB2YXJ5SGVhZGVyO1xyXG4gIHZhciByZXF1ZXN0SGVhZGVycyA9IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycyk7XHJcblxyXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyeUhlYWRlcnMubGVuZ3RoOyBpKyspIHtcclxuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XHJcblxyXG4gICAgaWYgKHZhcnlIZWFkZXIgPT0gJyonKSB7XHJcbiAgICAgIGNvbnRpbnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjcmVhdGVWYXJ5SUQoZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XHJcbiAgdmFyIGlkID0gJyc7XHJcblxyXG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcclxuICAgIHJldHVybiBpZDtcclxuICB9XHJcblxyXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcclxuICB2YXIgdmFyeUhlYWRlcjtcclxuXHJcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xyXG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcclxuXHJcbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcclxuICAgICAgY29udGludWU7XHJcbiAgICB9XHJcblxyXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gaWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcclxuICB2YXIgcmV0dXJuVmFsID0ge307XHJcblxyXG4gIGhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbiAodmFsdWUsIG5hbWUpIHtcclxuICAgIHJldHVyblZhbFtuYW1lLnRvTG93ZXJDYXNlKCldID0gdmFsdWU7XHJcbiAgfSk7XHJcblxyXG4gIHJldHVybiByZXR1cm5WYWw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xyXG4gIHZhciBlbnRyeVJlc3BvbnNlID0gZW50cnkucmVzcG9uc2U7XHJcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShlbnRyeVJlc3BvbnNlLmJvZHksIHtcclxuICAgIHN0YXR1czogZW50cnlSZXNwb25zZS5zdGF0dXMsXHJcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXHJcbiAgICBoZWFkZXJzOiBlbnRyeVJlc3BvbnNlLmhlYWRlcnNcclxuICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCBib2R5KSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIGJvZHk6IGJvZHksXHJcbiAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cyxcclxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXHJcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXNwb25zZS5oZWFkZXJzKVxyXG4gIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVudHJ5VG9SZXF1ZXN0KGVudHJ5KSB7XHJcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XHJcbiAgcmV0dXJuIG5ldyBSZXF1ZXN0KGVudHJ5UmVxdWVzdC51cmwsIHtcclxuICAgIG1vZGU6IGVudHJ5UmVxdWVzdC5tb2RlLFxyXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXHJcbiAgICBjcmVkZW50aWFsczogZW50cnlSZXF1ZXN0LmhlYWRlcnNcclxuICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWVzdFRvRW50cnkocmVxdWVzdCkge1xyXG4gIHJldHVybiB7XHJcbiAgICB1cmw6IHJlcXVlc3QudXJsLFxyXG4gICAgbW9kZTogcmVxdWVzdC5tb2RlLFxyXG4gICAgY3JlZGVudGlhbHM6IHJlcXVlc3QuY3JlZGVudGlhbHMsXHJcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpXHJcbiAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KSB7XHJcbiAgaWYgKCEocmVxdWVzdCBpbnN0YW5jZW9mIFJlcXVlc3QpKSB7XHJcbiAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XHJcbiAgfVxyXG4gIHJldHVybiByZXF1ZXN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBDYWNoZURCKCkge1xyXG4gIHRoaXMuZGIgPSBuZXcgSURCSGVscGVyKCdjYWNoZS1wb2x5ZmlsbCcsIDEsIGZ1bmN0aW9uKGRiLCBvbGRWZXJzaW9uKSB7XHJcbiAgICBzd2l0Y2ggKG9sZFZlcnNpb24pIHtcclxuICAgICAgY2FzZSAwOlxyXG4gICAgICAgIHZhciBuYW1lc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnLCB7XHJcbiAgICAgICAgICBrZXlQYXRoOiBbJ29yaWdpbicsICduYW1lJ11cclxuICAgICAgICB9KTtcclxuICAgICAgICBuYW1lc1N0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4nLCBbJ29yaWdpbicsICdhZGRlZCddKTtcclxuXHJcbiAgICAgICAgdmFyIGVudHJ5U3RvcmUgPSBkYi5jcmVhdGVPYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJywge1xyXG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ3ZhcnlJRCddXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZScsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdhZGRlZCddKTtcclxuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3RVcmxOb1NlYXJjaCcsICdhZGRlZCddKTtcclxuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICdhZGRlZCddKTtcclxuICAgIH1cclxuICB9KTtcclxufVxyXG5cclxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xyXG5cclxuQ2FjaGVEQlByb3RvLl9lYWNoQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xyXG4gIElEQkhlbHBlci5pdGVyYXRlKFxyXG4gICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5pbmRleCgnb3JpZ2luJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCAwXSwgW29yaWdpbiwgSW5maW5pdHldKSksXHJcbiAgICBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFja1xyXG4gICk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uX2VhY2hNYXRjaCA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xyXG4gIHBhcmFtcyA9IHBhcmFtcyB8fCB7fTtcclxuXHJcbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XHJcbiAgdmFyIGlnbm9yZU1ldGhvZCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZU1ldGhvZCk7XHJcbiAgdmFyIGlnbm9yZVZhcnkgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVWYXJ5KTtcclxuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XHJcblxyXG4gIGlmICghaWdub3JlTWV0aG9kICYmXHJcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxyXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSB7XHJcbiAgICAvLyB3ZSBvbmx5IHN0b3JlIEdFVCByZXNwb25zZXMgYXQgdGhlIG1vbWVudCwgc28gbm8gbWF0Y2hcclxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcclxuICB9XHJcblxyXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XHJcbiAgdmFyIHJhbmdlO1xyXG4gIHZhciBpbmRleDtcclxuICB2YXIgaW5kZXhOYW1lID0gJ29yaWdpbi1jYWNoZU5hbWUtdXJsJztcclxuICB2YXIgdXJsVG9NYXRjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xyXG5cclxuICB1cmxUb01hdGNoLmhhc2ggPSAnJztcclxuXHJcbiAgaWYgKGlnbm9yZVNlYXJjaCkge1xyXG4gICAgdXJsVG9NYXRjaC5zZWFyY2ggPSAnJztcclxuICAgIGluZGV4TmFtZSArPSAnTm9TZWFyY2gnO1xyXG4gIH1cclxuXHJcbiAgLy8gd29ya2luZyBhcm91bmQgY2hyb21lIGJ1Z3NcclxuICB1cmxUb01hdGNoID0gdXJsVG9NYXRjaC5ocmVmLnJlcGxhY2UoLyhcXD98I3xcXD8jKSQvLCAnJyk7XHJcblxyXG4gIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KGluZGV4TmFtZSk7XHJcblxyXG4gIGlmIChwcmVmaXhNYXRjaCkge1xyXG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2ggKyBTdHJpbmcuZnJvbUNoYXJDb2RlKDY1NTM1KSwgSW5maW5pdHldKTtcclxuICB9XHJcbiAgZWxzZSB7XHJcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgSW5maW5pdHldKTtcclxuICB9XHJcblxyXG4gIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IocmFuZ2UpLCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgIHZhciB2YWx1ZSA9IGN1cnNvci52YWx1ZTtcclxuICAgIFxyXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcclxuICAgICAgLy8gaXQncyBkb3duIHRvIHRoZSBjYWxsYmFjayB0byBjYWxsIGN1cnNvci5jb250aW51ZSgpXHJcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xyXG4gICAgfVxyXG4gIH0sIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjayk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uX2hhc0NhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XHJcbiAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcclxuICByZXR1cm4gSURCSGVscGVyLmNhbGxiYWNraWZ5KHN0b3JlLmdldChbb3JpZ2luLCBjYWNoZU5hbWVdKSwgZnVuY3Rpb24odmFsKSB7XHJcbiAgICBkb25lQ2FsbGJhY2soISF2YWwpO1xyXG4gIH0sIGVyckNhbGxiYWNrKTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5fZGVsZXRlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrLCBwYXJhbXMpIHtcclxuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XHJcblxyXG4gIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgcmV0dXJuVmFsID0gdHJ1ZTtcclxuICAgIGN1cnNvci5kZWxldGUoKTtcclxuICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gIH0sIGZ1bmN0aW9uKCkge1xyXG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xyXG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcclxuICAgIH1cclxuICB9LCBlcnJDYWxsYmFjaywgcGFyYW1zKTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5tYXRjaEFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaGVzID0gW107XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5hbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XHJcbiAgdmFyIG1hdGNoZXMgPSBbXTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xyXG4gICAgdmFyIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJyk7XHJcblxyXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gICAgfSk7XHJcbiAgfSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgdmFyIG1hdGNoZXMgPSBbXTtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVzcG9uc2UpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm1hdGNoID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaDtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xyXG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5tYXRjaEFjcm9zc0NhY2hlcyA9IGZ1bmN0aW9uKG9yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgdmFyIG1hdGNoO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5fZWFjaENhY2hlKHR4LCBvcmlnaW4sIGZ1bmN0aW9uKG5hbWVzQ3Vyc29yKSB7XHJcbiAgICAgIHZhciBjYWNoZU5hbWUgPSBuYW1lc0N1cnNvci52YWx1ZS5uYW1lO1xyXG5cclxuICAgICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24gZWFjaChyZXNwb25zZUN1cnNvcikge1xyXG4gICAgICAgIG1hdGNoID0gcmVzcG9uc2VDdXJzb3IudmFsdWU7XHJcbiAgICAgIH0sIGZ1bmN0aW9uIGRvbmUoKSB7XHJcbiAgICAgICAgaWYgKCFtYXRjaCkge1xyXG4gICAgICAgICAgbmFtZXNDdXJzb3IuY29udGludWUoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIHVuZGVmaW5lZCwgcGFyYW1zKTtcclxuICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5jYWNoZU5hbWVzID0gZnVuY3Rpb24ob3JpZ2luKSB7XHJcbiAgdmFyIG5hbWVzID0gW107XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbmFtZXMucHVzaChjdXJzb3IudmFsdWUubmFtZSk7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gICAgfS5iaW5kKHRoaXMpKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbmFtZXM7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciByZXR1cm5WYWw7XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcywgZnVuY3Rpb24odikge1xyXG4gICAgICByZXR1cm5WYWwgPSB2O1xyXG4gICAgfSk7XHJcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIHJldHVyblZhbDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5vcGVuQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XHJcbiAgICAgIGlmICh2YWwpIHsgcmV0dXJuOyB9XHJcbiAgICAgIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XHJcbiAgICAgIHN0b3JlLmFkZCh7XHJcbiAgICAgICAgb3JpZ2luOiBvcmlnaW4sXHJcbiAgICAgICAgbmFtZTogY2FjaGVOYW1lLFxyXG4gICAgICAgIGFkZGVkOiBEYXRlLm5vdygpXHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5oYXNDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XHJcbiAgdmFyIHJldHVyblZhbDtcclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgICByZXR1cm5WYWwgPSB2YWw7XHJcbiAgICB9KTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24odmFsKSB7XHJcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmRlbGV0ZUNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcclxuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcclxuICAgIElEQkhlbHBlci5pdGVyYXRlKFxyXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShbb3JpZ2luLCBjYWNoZU5hbWVdKSksXHJcbiAgICAgIGRlbFxyXG4gICAgKTtcclxuXHJcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcclxuICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpLmluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLFxyXG4gICAgICBkZWxcclxuICAgICk7XHJcblxyXG4gICAgZnVuY3Rpb24gZGVsKGN1cnNvcikge1xyXG4gICAgICByZXR1cm5WYWwgPSB0cnVlO1xyXG4gICAgICBjdXJzb3IuZGVsZXRlKCk7XHJcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xyXG4gICAgfVxyXG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiByZXR1cm5WYWw7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ucHV0ID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIGl0ZW1zKSB7XHJcbiAgLy8gaXRlbXMgaXMgW1tyZXF1ZXN0LCByZXNwb25zZV0sIFtyZXF1ZXN0LCByZXNwb25zZV0sIOKApl1cclxuICB2YXIgaXRlbTtcclxuXHJcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBpdGVtcy5sZW5ndGg7IGkrKykge1xyXG4gICAgaXRlbXNbaV1bMF0gPSBjYXN0VG9SZXF1ZXN0KGl0ZW1zW2ldWzBdKTtcclxuXHJcbiAgICBpZiAoaXRlbXNbaV1bMF0ubWV0aG9kICE9ICdHRVQnKSB7XHJcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoJ09ubHkgR0VUIHJlcXVlc3RzIGFyZSBzdXBwb3J0ZWQnKSk7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKGl0ZW1zW2ldWzFdLnR5cGUgPT0gJ29wYXF1ZScpIHtcclxuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcihcIlRoZSBwb2x5ZmlsbCBkb2Vzbid0IHN1cHBvcnQgb3BhcXVlIHJlc3BvbnNlcyAoZnJvbSBjcm9zcy1vcmlnaW4gbm8tY29ycyByZXF1ZXN0cylcIikpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIGVuc3VyZSBlYWNoIGVudHJ5IGJlaW5nIHB1dCB3b24ndCBvdmVyd3JpdGUgZWFybGllciBlbnRyaWVzIGJlaW5nIHB1dFxyXG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBpOyBqKyspIHtcclxuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcclxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdQdXRzIHdvdWxkIG92ZXJ3cml0ZSBlYWNob3RoZXInKSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIHJldHVybiBQcm9taXNlLmFsbChcclxuICAgIGl0ZW1zLm1hcChmdW5jdGlvbihpdGVtKSB7XHJcbiAgICAgIHJldHVybiBpdGVtWzFdLmJsb2IoKTtcclxuICAgIH0pXHJcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlQm9kaWVzKSB7XHJcbiAgICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24oaGFzQ2FjaGUpIHtcclxuICAgICAgICBpZiAoIWhhc0NhY2hlKSB7XHJcbiAgICAgICAgICB0aHJvdyBFcnJvcihcIkNhY2hlIG9mIHRoYXQgbmFtZSBkb2VzIG5vdCBleGlzdFwiKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24oaXRlbSwgaSkge1xyXG4gICAgICAgICAgdmFyIHJlcXVlc3QgPSBpdGVtWzBdO1xyXG4gICAgICAgICAgdmFyIHJlc3BvbnNlID0gaXRlbVsxXTtcclxuICAgICAgICAgIHZhciByZXF1ZXN0RW50cnkgPSByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KTtcclxuICAgICAgICAgIHZhciByZXNwb25zZUVudHJ5ID0gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCByZXNwb25zZUJvZGllc1tpXSk7XHJcblxyXG4gICAgICAgICAgdmFyIHJlcXVlc3RVcmxOb1NlYXJjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwpO1xyXG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoLnNlYXJjaCA9ICcnO1xyXG4gICAgICAgICAgLy8gd29ya2luZyBhcm91bmQgQ2hyb21lIGJ1Z1xyXG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoID0gcmVxdWVzdFVybE5vU2VhcmNoLmhyZWYucmVwbGFjZSgvXFw/JC8sICcnKTtcclxuXHJcbiAgICAgICAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbigpIHtcclxuICAgICAgICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpLmFkZCh7XHJcbiAgICAgICAgICAgICAgb3JpZ2luOiBvcmlnaW4sXHJcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiBjYWNoZU5hbWUsXHJcbiAgICAgICAgICAgICAgcmVxdWVzdDogcmVxdWVzdEVudHJ5LFxyXG4gICAgICAgICAgICAgIHJlc3BvbnNlOiByZXNwb25zZUVudHJ5LFxyXG4gICAgICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaDogcmVxdWVzdFVybE5vU2VhcmNoLFxyXG4gICAgICAgICAgICAgIHZhcnlJRDogY3JlYXRlVmFyeUlEKHJlcXVlc3RFbnRyeSwgcmVzcG9uc2VFbnRyeSksXHJcbiAgICAgICAgICAgICAgYWRkZWQ6IERhdGUubm93KClcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgfS5iaW5kKHRoaXMpKTtcclxuICAgICAgfS5iaW5kKHRoaXMpKTtcclxuICAgIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICB9KTtcclxufTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlREIoKTsiLCJ2YXIgY2FjaGVEQiA9IHJlcXVpcmUoJy4vY2FjaGVkYicpO1xyXG52YXIgQ2FjaGUgPSByZXF1aXJlKCcuL2NhY2hlJyk7XHJcblxyXG5mdW5jdGlvbiBDYWNoZVN0b3JhZ2UoKSB7XHJcbiAgdGhpcy5fb3JpZ2luID0gbG9jYXRpb24ub3JpZ2luO1xyXG59XHJcblxyXG52YXIgQ2FjaGVTdG9yYWdlUHJvdG8gPSBDYWNoZVN0b3JhZ2UucHJvdG90eXBlO1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8uX3ZlbmRDYWNoZSA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICB2YXIgY2FjaGUgPSBuZXcgQ2FjaGUoKTtcclxuICBjYWNoZS5fbmFtZSA9IG5hbWU7XHJcbiAgY2FjaGUuX29yaWdpbiA9IHRoaXMuX29yaWdpbjtcclxuICByZXR1cm4gY2FjaGU7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWNyb3NzQ2FjaGVzKHRoaXMuX29yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLmhhcyA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICByZXR1cm4gY2FjaGVEQi5oYXNDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8ub3BlbiA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICByZXR1cm4gY2FjaGVEQi5vcGVuQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcclxuICB9LmJpbmQodGhpcykpO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24obmFtZSkge1xyXG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZUNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5rZXlzID0gZnVuY3Rpb24oKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIuY2FjaGVOYW1lcyh0aGlzLl9vcmlnaW4pO1xyXG59O1xyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XHJcbiIsImZ1bmN0aW9uIElEQkhlbHBlcihuYW1lLCB2ZXJzaW9uLCB1cGdyYWRlQ2FsbGJhY2spIHtcclxuICB2YXIgcmVxdWVzdCA9IChzZWxmLl9pbmRleGVkREIgfHwgc2VsZi5pbmRleGVkREIpLm9wZW4obmFtZSwgdmVyc2lvbik7XHJcbiAgdGhpcy5yZWFkeSA9IElEQkhlbHBlci5wcm9taXNpZnkocmVxdWVzdCk7XHJcbiAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSBmdW5jdGlvbihldmVudCkge1xyXG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcclxuICB9O1xyXG59XHJcblxyXG5JREJIZWxwZXIuc3VwcG9ydGVkID0gJ19pbmRleGVkREInIGluIHNlbGYgfHwgJ2luZGV4ZWREQicgaW4gc2VsZjtcclxuXHJcbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcclxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XHJcbiAgICBJREJIZWxwZXIuY2FsbGJhY2tpZnkob2JqLCByZXNvbHZlLCByZWplY3QpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XHJcbiAgZnVuY3Rpb24gb25zdWNjZXNzKGV2ZW50KSB7XHJcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XHJcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcclxuICAgIH1cclxuICB9XHJcbiAgZnVuY3Rpb24gb25lcnJvcihldmVudCkge1xyXG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XHJcbiAgICAgIGVyckNhbGxiYWNrKG9iai5lcnJvcik7XHJcbiAgICB9XHJcbiAgfVxyXG4gIG9iai5vbmNvbXBsZXRlID0gb25zdWNjZXNzO1xyXG4gIG9iai5vbnN1Y2Nlc3MgPSBvbnN1Y2Nlc3M7XHJcbiAgb2JqLm9uZXJyb3IgPSBvbmVycm9yO1xyXG4gIG9iai5vbmFib3J0ID0gb25lcnJvcjtcclxufTtcclxuXHJcbklEQkhlbHBlci5pdGVyYXRlID0gZnVuY3Rpb24oY3Vyc29yUmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcclxuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XHJcblxyXG4gIGZ1bmN0aW9uIGN1cnNvckNvbnRpbnVlKCkge1xyXG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XHJcbiAgICByZXR1cm4gb2xkQ3Vyc29yQ29udGludWUuY2FsbCh0aGlzKTtcclxuICB9XHJcblxyXG4gIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gZnVuY3Rpb24oKSB7XHJcbiAgICB2YXIgY3Vyc29yID0gY3Vyc29yUmVxdWVzdC5yZXN1bHQ7XHJcblxyXG4gICAgaWYgKCFjdXJzb3IpIHtcclxuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xyXG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoY3Vyc29yLmNvbnRpbnVlICE9IGN1cnNvckNvbnRpbnVlKSB7XHJcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xyXG4gICAgICBjdXJzb3IuY29udGludWUgPSBjdXJzb3JDb250aW51ZTtcclxuICAgIH1cclxuXHJcbiAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcclxuXHJcbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xyXG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XHJcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9O1xyXG5cclxuICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHtcclxuICAgIGlmIChlcnJvckNhbGxiYWNrKSB7XHJcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XHJcbiAgICB9XHJcbiAgfTtcclxufTtcclxuXHJcbnZhciBJREJIZWxwZXJQcm90byA9IElEQkhlbHBlci5wcm90b3R5cGU7XHJcblxyXG5JREJIZWxwZXJQcm90by50cmFuc2FjdGlvbiA9IGZ1bmN0aW9uKHN0b3JlcywgY2FsbGJhY2ssIG9wdHMpIHtcclxuICBvcHRzID0gb3B0cyB8fCB7fTtcclxuXHJcbiAgcmV0dXJuIHRoaXMucmVhZHkudGhlbihmdW5jdGlvbihkYikge1xyXG4gICAgdmFyIG1vZGUgPSBvcHRzLm1vZGUgfHwgJ3JlYWRvbmx5JztcclxuXHJcbiAgICB2YXIgdHggPSBkYi50cmFuc2FjdGlvbihzdG9yZXMsIG1vZGUpO1xyXG4gICAgY2FsbGJhY2sodHgsIGRiKTtcclxuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcclxuICB9KTtcclxufTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gSURCSGVscGVyOyJdfQ==
