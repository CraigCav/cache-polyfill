(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
if(!window.caches) window.caches = require('../lib/caches.js');
window.cachesPolyfill = require('../lib/caches.js');
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

function responseToBlob(response) {
  var byteString = atob(response.body);
  var content = [];
  for (var i = 0; i < byteString.length; i++) {
    content[i] = byteString.charCodeAt(i);
  }
  return new Blob([new Uint8Array(content)], { type: response.headers['content-type'] });
}

function blobToBase64(blob) {
  return new Promise(function(resolve) {
    var reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = function() {
      var dataUrl = reader.result;
      resolve(dataUrl.split(',')[1]);
    };
  });
}

function entryToResponse(entry) {
  var entryResponse = entry.response;
  return new Response(responseToBlob(entryResponse), {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, base64EncodedResponseBody) {
  return {
    body: base64EncodedResponseBody,
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
  var urlToMatch = new URL(request.url, document.location);

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
      return item[1].blob().then(function(blob) {
        return blobToBase64(blob);
      });
    })
  ).then(function(base64EncodedResponseBodies) {
    return this.db.transaction(['cacheEntries', 'cacheNames'], function(tx) {
      this._hasCache(tx, origin, cacheName, function(hasCache) {
        if (!hasCache) {
          throw Error("Cache of that name does not exist");
        }

        items.forEach(function(item, i) {
          var request = item[0];
          var response = item[1];
          var requestEntry = requestToEntry(request);
          var responseEntry = responseToEntry(response, base64EncodedResponseBodies[i]);

          var requestUrlNoSearch = new URL(request.url, document.location);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlc1xcYnJvd3Nlci1wYWNrXFxfcHJlbHVkZS5qcyIsIi4vYnVpbGQvaW5kZXguanMiLCJDOi9naXQvY2FjaGUtcG9seWZpbGwvbGliL2NhY2hlLmpzIiwiQzovZ2l0L2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZWRiLmpzIiwiQzovZ2l0L2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZXMuanMiLCJDOi9naXQvY2FjaGUtcG9seWZpbGwvbGliL2lkYmhlbHBlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3YkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJpZighd2luZG93LmNhY2hlcykgd2luZG93LmNhY2hlcyA9IHJlcXVpcmUoJy4uL2xpYi9jYWNoZXMuanMnKTtcclxud2luZG93LmNhY2hlc1BvbHlmaWxsID0gcmVxdWlyZSgnLi4vbGliL2NhY2hlcy5qcycpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XHJcblxyXG5mdW5jdGlvbiBDYWNoZSgpIHtcclxuICB0aGlzLl9uYW1lID0gJyc7XHJcbiAgdGhpcy5fb3JpZ2luID0gJyc7XHJcbn1cclxuXHJcbnZhciBDYWNoZVByb3RvID0gQ2FjaGUucHJvdG90eXBlO1xyXG5cclxuQ2FjaGVQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHJldHVybiBjYWNoZURCLm1hdGNoKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLmFkZEFsbCA9IGZ1bmN0aW9uKHJlcXVlc3RzKSB7XHJcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxyXG4gICAgcmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcclxuICAgICAgcmV0dXJuIGZldGNoKHJlcXVlc3QpO1xyXG4gICAgfSlcclxuICApLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VzKSB7XHJcbiAgICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XHJcbiAgICAgIHJldHVybiBbcmVxdWVzdHNbaV0sIHJlc3BvbnNlXTtcclxuICAgIH0pKTtcclxuICB9LmJpbmQodGhpcykpO1xyXG59O1xyXG5cclxuQ2FjaGVQcm90by5hZGQgPSBmdW5jdGlvbihyZXF1ZXN0KSB7XHJcbiAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XHJcbn07XHJcblxyXG5DYWNoZVByb3RvLnB1dCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlKSB7XHJcbiAgaWYgKCEocmVzcG9uc2UgaW5zdGFuY2VvZiBSZXNwb25zZSkpIHtcclxuICAgIHRocm93IFR5cGVFcnJvcihcIkluY29ycmVjdCByZXNwb25zZSB0eXBlXCIpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGNhY2hlREIucHV0KHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgW1tyZXF1ZXN0LCByZXNwb25zZV1dKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcclxufTtcclxuXHJcbkNhY2hlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIGlmIChyZXF1ZXN0KSB7XHJcbiAgICByZXR1cm4gY2FjaGVEQi5tYXRjaEFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcclxuICB9XHJcbiAgZWxzZSB7XHJcbiAgICByZXR1cm4gY2FjaGVEQi5hbGxSZXF1ZXN0cyh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUpO1xyXG4gIH1cclxufTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gQ2FjaGU7XHJcbiIsInZhciBJREJIZWxwZXIgPSByZXF1aXJlKCcuL2lkYmhlbHBlcicpO1xyXG5cclxuZnVuY3Rpb24gbWF0Y2hlc1ZhcnkocmVxdWVzdCwgZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XHJcbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfVxyXG5cclxuICB2YXIgdmFyeUhlYWRlcnMgPSBlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KCcsJyk7XHJcbiAgdmFyIHZhcnlIZWFkZXI7XHJcbiAgdmFyIHJlcXVlc3RIZWFkZXJzID0gZmxhdHRlbkhlYWRlcnMocmVxdWVzdC5oZWFkZXJzKTtcclxuXHJcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xyXG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcclxuXHJcbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcclxuICAgICAgY29udGludWU7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKGVudHJ5UmVxdWVzdC5oZWFkZXJzW3ZhcnlIZWFkZXJdICE9IHJlcXVlc3RIZWFkZXJzW3ZhcnlIZWFkZXJdKSB7XHJcbiAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICB9XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNyZWF0ZVZhcnlJRChlbnRyeVJlcXVlc3QsIGVudHJ5UmVzcG9uc2UpIHtcclxuICB2YXIgaWQgPSAnJztcclxuXHJcbiAgaWYgKCFlbnRyeVJlc3BvbnNlLmhlYWRlcnMudmFyeSkge1xyXG4gICAgcmV0dXJuIGlkO1xyXG4gIH1cclxuXHJcbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xyXG4gIHZhciB2YXJ5SGVhZGVyO1xyXG5cclxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICB2YXJ5SGVhZGVyID0gdmFyeUhlYWRlcnNbaV0udHJpbSgpO1xyXG5cclxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xyXG4gICAgICBjb250aW51ZTtcclxuICAgIH1cclxuXHJcbiAgICBpZCArPSB2YXJ5SGVhZGVyICsgJzogJyArIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSB8fCAnJykgKyAnXFxuJztcclxuICB9XHJcblxyXG4gIHJldHVybiBpZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbkhlYWRlcnMoaGVhZGVycykge1xyXG4gIHZhciByZXR1cm5WYWwgPSB7fTtcclxuXHJcbiAgaGVhZGVycy5mb3JFYWNoKGZ1bmN0aW9uICh2YWx1ZSwgbmFtZSkge1xyXG4gICAgcmV0dXJuVmFsW25hbWUudG9Mb3dlckNhc2UoKV0gPSB2YWx1ZTtcclxuICB9KTtcclxuXHJcbiAgcmV0dXJuIHJldHVyblZhbDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzcG9uc2VUb0Jsb2IocmVzcG9uc2UpIHtcclxuICB2YXIgYnl0ZVN0cmluZyA9IGF0b2IocmVzcG9uc2UuYm9keSk7XHJcbiAgdmFyIGNvbnRlbnQgPSBbXTtcclxuICBmb3IgKHZhciBpID0gMDsgaSA8IGJ5dGVTdHJpbmcubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnRlbnRbaV0gPSBieXRlU3RyaW5nLmNoYXJDb2RlQXQoaSk7XHJcbiAgfVxyXG4gIHJldHVybiBuZXcgQmxvYihbbmV3IFVpbnQ4QXJyYXkoY29udGVudCldLCB7IHR5cGU6IHJlc3BvbnNlLmhlYWRlcnNbJ2NvbnRlbnQtdHlwZSddIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBibG9iVG9CYXNlNjQoYmxvYikge1xyXG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlKSB7XHJcbiAgICB2YXIgcmVhZGVyID0gbmV3IEZpbGVSZWFkZXIoKTtcclxuICAgIHJlYWRlci5yZWFkQXNEYXRhVVJMKGJsb2IpO1xyXG4gICAgcmVhZGVyLm9ubG9hZGVuZCA9IGZ1bmN0aW9uKCkge1xyXG4gICAgICB2YXIgZGF0YVVybCA9IHJlYWRlci5yZXN1bHQ7XHJcbiAgICAgIHJlc29sdmUoZGF0YVVybC5zcGxpdCgnLCcpWzFdKTtcclxuICAgIH07XHJcbiAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVudHJ5VG9SZXNwb25zZShlbnRyeSkge1xyXG4gIHZhciBlbnRyeVJlc3BvbnNlID0gZW50cnkucmVzcG9uc2U7XHJcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShyZXNwb25zZVRvQmxvYihlbnRyeVJlc3BvbnNlKSwge1xyXG4gICAgc3RhdHVzOiBlbnRyeVJlc3BvbnNlLnN0YXR1cyxcclxuICAgIHN0YXR1c1RleHQ6IGVudHJ5UmVzcG9uc2Uuc3RhdHVzVGV4dCxcclxuICAgIGhlYWRlcnM6IGVudHJ5UmVzcG9uc2UuaGVhZGVyc1xyXG4gIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJhc2U2NEVuY29kZWRSZXNwb25zZUJvZHkpIHtcclxuICByZXR1cm4ge1xyXG4gICAgYm9keTogYmFzZTY0RW5jb2RlZFJlc3BvbnNlQm9keSxcclxuICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxyXG4gICAgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCxcclxuICAgIGhlYWRlcnM6IGZsYXR0ZW5IZWFkZXJzKHJlc3BvbnNlLmhlYWRlcnMpXHJcbiAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW50cnlUb1JlcXVlc3QoZW50cnkpIHtcclxuICB2YXIgZW50cnlSZXF1ZXN0ID0gZW50cnkucmVxdWVzdDtcclxuICByZXR1cm4gbmV3IFJlcXVlc3QoZW50cnlSZXF1ZXN0LnVybCwge1xyXG4gICAgbW9kZTogZW50cnlSZXF1ZXN0Lm1vZGUsXHJcbiAgICBoZWFkZXJzOiBlbnRyeVJlcXVlc3QuaGVhZGVycyxcclxuICAgIGNyZWRlbnRpYWxzOiBlbnRyeVJlcXVlc3QuaGVhZGVyc1xyXG4gIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KSB7XHJcbiAgcmV0dXJuIHtcclxuICAgIHVybDogcmVxdWVzdC51cmwudG9TdHJpbmcoKSxcclxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcclxuICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmNyZWRlbnRpYWxzLFxyXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVxdWVzdC5oZWFkZXJzKVxyXG4gIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xyXG4gIGlmICghKHJlcXVlc3QgaW5zdGFuY2VvZiBSZXF1ZXN0KSkge1xyXG4gICAgcmVxdWVzdCA9IG5ldyBSZXF1ZXN0KHJlcXVlc3QpO1xyXG4gIH1cclxuICByZXR1cm4gcmVxdWVzdDtcclxufVxyXG5cclxuZnVuY3Rpb24gQ2FjaGVEQigpIHtcclxuICB0aGlzLmRiID0gbmV3IElEQkhlbHBlcignY2FjaGUtcG9seWZpbGwnLCAxLCBmdW5jdGlvbihkYiwgb2xkVmVyc2lvbikge1xyXG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XHJcbiAgICAgIGNhc2UgMDpcclxuICAgICAgICB2YXIgbmFtZXNTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJywge1xyXG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbmFtZXNTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luJywgWydvcmlnaW4nLCAnYWRkZWQnXSk7XHJcblxyXG4gICAgICAgIHZhciBlbnRyeVN0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycsIHtcclxuICAgICAgICAgIGtleVBhdGg6IFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0LnVybCcsICd2YXJ5SUQnXVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGVudHJ5U3RvcmUuY3JlYXRlSW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAnYWRkZWQnXSk7XHJcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmxOb1NlYXJjaCcsIFsnb3JpZ2luJywgJ2NhY2hlTmFtZScsICdyZXF1ZXN0VXJsTm9TZWFyY2gnLCAnYWRkZWQnXSk7XHJcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XHJcbiAgICB9XHJcbiAgfSk7XHJcbn1cclxuXHJcbnZhciBDYWNoZURCUHJvdG8gPSBDYWNoZURCLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlREJQcm90by5fZWFjaENhY2hlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spIHtcclxuICBJREJIZWxwZXIuaXRlcmF0ZShcclxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxyXG4gICAgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2tcclxuICApO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLl9lYWNoTWF0Y2ggPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrLCBwYXJhbXMpIHtcclxuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XHJcblxyXG4gIHZhciBpZ25vcmVTZWFyY2ggPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVTZWFyY2gpO1xyXG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xyXG4gIHZhciBpZ25vcmVWYXJ5ID0gQm9vbGVhbihwYXJhbXMuaWdub3JlVmFyeSk7XHJcbiAgdmFyIHByZWZpeE1hdGNoID0gQm9vbGVhbihwYXJhbXMucHJlZml4TWF0Y2gpO1xyXG5cclxuICBpZiAoIWlnbm9yZU1ldGhvZCAmJlxyXG4gICAgICByZXF1ZXN0Lm1ldGhvZCAhPT0gJ0dFVCcgJiZcclxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xyXG4gICAgLy8gd2Ugb25seSBzdG9yZSBHRVQgcmVzcG9uc2VzIGF0IHRoZSBtb21lbnQsIHNvIG5vIG1hdGNoXHJcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbiAgfVxyXG5cclxuICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xyXG4gIHZhciByYW5nZTtcclxuICB2YXIgaW5kZXg7XHJcbiAgdmFyIGluZGV4TmFtZSA9ICdvcmlnaW4tY2FjaGVOYW1lLXVybCc7XHJcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsLCBkb2N1bWVudC5sb2NhdGlvbik7XHJcblxyXG4gIHVybFRvTWF0Y2guaGFzaCA9ICcnO1xyXG5cclxuICBpZiAoaWdub3JlU2VhcmNoKSB7XHJcbiAgICB1cmxUb01hdGNoLnNlYXJjaCA9ICcnO1xyXG4gICAgaW5kZXhOYW1lICs9ICdOb1NlYXJjaCc7XHJcbiAgfVxyXG5cclxuICAvLyB3b3JraW5nIGFyb3VuZCBjaHJvbWUgYnVnc1xyXG4gIHVybFRvTWF0Y2ggPSB1cmxUb01hdGNoLmhyZWYucmVwbGFjZSgvKFxcP3wjfFxcPyMpJC8sICcnKTtcclxuXHJcbiAgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoaW5kZXhOYW1lKTtcclxuXHJcbiAgaWYgKHByZWZpeE1hdGNoKSB7XHJcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjU1MzUpLCBJbmZpbml0eV0pO1xyXG4gIH1cclxuICBlbHNlIHtcclxuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCBJbmZpbml0eV0pO1xyXG4gIH1cclxuXHJcbiAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihyYW5nZSksIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgdmFyIHZhbHVlID0gY3Vyc29yLnZhbHVlO1xyXG5cclxuICAgIGlmIChpZ25vcmVWYXJ5IHx8IG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVzcG9uc2UpKSB7XHJcbiAgICAgIC8vIGl0J3MgZG93biB0byB0aGUgY2FsbGJhY2sgdG8gY2FsbCBjdXJzb3IuY29udGludWUoKVxyXG4gICAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcclxuICAgIH1cclxuICB9LCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLl9oYXNDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xyXG4gIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XHJcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgZG9uZUNhbGxiYWNrKCEhdmFsKTtcclxuICB9LCBlcnJDYWxsYmFjayk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uX2RlbGV0ZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaywgcGFyYW1zKSB7XHJcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xyXG5cclxuICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgIHJldHVyblZhbCA9IHRydWU7XHJcbiAgICBjdXJzb3IuZGVsZXRlKCk7XHJcbiAgICBjdXJzb3IuY29udGludWUoKTtcclxuICB9LCBmdW5jdGlvbigpIHtcclxuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgZG9uZUNhbGxiYWNrKHJldHVyblZhbCk7XHJcbiAgICB9XHJcbiAgfSwgZXJyQ2FsbGJhY2ssIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2hlcyA9IFtdO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcclxuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci5rZXkpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uYWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHZhciBtYXRjaGVzID0gW107XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdmFyIGNhY2hlRW50cmllcyA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKTtcclxuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xyXG5cclxuICAgIElEQkhlbHBlci5pdGVyYXRlKGluZGV4Lm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0pO1xyXG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaGVzID0gW107XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcclxuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1Jlc3BvbnNlKTtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5tYXRjaCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgbWF0Y2g7XHJcblxyXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xyXG4gICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcclxuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ubWF0Y2hBY3Jvc3NDYWNoZXMgPSBmdW5jdGlvbihvcmlnaW4sIHJlcXVlc3QsIHBhcmFtcykge1xyXG4gIHZhciBtYXRjaDtcclxuXHJcbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XHJcblxyXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcclxuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihuYW1lc0N1cnNvcikge1xyXG4gICAgICB2YXIgY2FjaGVOYW1lID0gbmFtZXNDdXJzb3IudmFsdWUubmFtZTtcclxuXHJcbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uIGVhY2gocmVzcG9uc2VDdXJzb3IpIHtcclxuICAgICAgICBtYXRjaCA9IHJlc3BvbnNlQ3Vyc29yLnZhbHVlO1xyXG4gICAgICB9LCBmdW5jdGlvbiBkb25lKCkge1xyXG4gICAgICAgIGlmICghbWF0Y2gpIHtcclxuICAgICAgICAgIG5hbWVzQ3Vyc29yLmNvbnRpbnVlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9LCB1bmRlZmluZWQsIHBhcmFtcyk7XHJcbiAgICB9LmJpbmQodGhpcykpO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uY2FjaGVOYW1lcyA9IGZ1bmN0aW9uKG9yaWdpbikge1xyXG4gIHZhciBuYW1lcyA9IFtdO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XHJcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlLm5hbWUpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xyXG4gICAgcmV0dXJuIG5hbWVzO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcclxuICB2YXIgcmV0dXJuVmFsO1xyXG5cclxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcclxuXHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMsIGZ1bmN0aW9uKHYpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdjtcclxuICAgIH0pO1xyXG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiByZXR1cm5WYWw7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8ub3BlbkNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgICBpZiAodmFsKSB7IHJldHVybjsgfVxyXG4gICAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xyXG4gICAgICBzdG9yZS5hZGQoe1xyXG4gICAgICAgIG9yaWdpbjogb3JpZ2luLFxyXG4gICAgICAgIG5hbWU6IGNhY2hlTmFtZSxcclxuICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XHJcbn07XHJcblxyXG5DYWNoZURCUHJvdG8uaGFzQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xyXG4gIHZhciByZXR1cm5WYWw7XHJcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xyXG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdmFsO1xyXG4gICAgfSk7XHJcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xyXG4gICAgcmV0dXJuIHJldHVyblZhbDtcclxuICB9KTtcclxufTtcclxuXHJcbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XHJcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xyXG5cclxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XHJcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcclxuICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLm9ubHkoW29yaWdpbiwgY2FjaGVOYW1lXSkpLFxyXG4gICAgICBkZWxcclxuICAgICk7XHJcblxyXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXHJcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSxcclxuICAgICAgZGVsXHJcbiAgICApO1xyXG5cclxuICAgIGZ1bmN0aW9uIGRlbChjdXJzb3IpIHtcclxuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcclxuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xyXG4gICAgICBjdXJzb3IuY29udGludWUoKTtcclxuICAgIH1cclxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XHJcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xyXG4gIH0pO1xyXG59O1xyXG5cclxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xyXG4gIC8vIGl0ZW1zIGlzIFtbcmVxdWVzdCwgcmVzcG9uc2VdLCBbcmVxdWVzdCwgcmVzcG9uc2VdLCDigKZdXHJcbiAgdmFyIGl0ZW07XHJcblxyXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaXRlbXMubGVuZ3RoOyBpKyspIHtcclxuICAgIGl0ZW1zW2ldWzBdID0gY2FzdFRvUmVxdWVzdChpdGVtc1tpXVswXSk7XHJcblxyXG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdPbmx5IEdFVCByZXF1ZXN0cyBhcmUgc3VwcG9ydGVkJykpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChpdGVtc1tpXVsxXS50eXBlID09ICdvcGFxdWUnKSB7XHJcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoXCJUaGUgcG9seWZpbGwgZG9lc24ndCBzdXBwb3J0IG9wYXF1ZSByZXNwb25zZXMgKGZyb20gY3Jvc3Mtb3JpZ2luIG5vLWNvcnMgcmVxdWVzdHMpXCIpKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcclxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XHJcbiAgICAgIGlmIChpdGVtc1tpXVswXS51cmwgPT0gaXRlbXNbal1bMF0udXJsICYmIG1hdGNoZXNWYXJ5KGl0ZW1zW2pdWzBdLCBpdGVtc1tpXVswXSwgaXRlbXNbaV1bMV0pKSB7XHJcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gUHJvbWlzZS5hbGwoXHJcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xyXG4gICAgICByZXR1cm4gaXRlbVsxXS5ibG9iKCkudGhlbihmdW5jdGlvbihibG9iKSB7XHJcbiAgICAgICAgcmV0dXJuIGJsb2JUb0Jhc2U2NChibG9iKTtcclxuICAgICAgfSk7XHJcbiAgICB9KVxyXG4gICkudGhlbihmdW5jdGlvbihiYXNlNjRFbmNvZGVkUmVzcG9uc2VCb2RpZXMpIHtcclxuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcclxuICAgICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbihoYXNDYWNoZSkge1xyXG4gICAgICAgIGlmICghaGFzQ2FjaGUpIHtcclxuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XHJcbiAgICAgICAgICB2YXIgcmVxdWVzdCA9IGl0ZW1bMF07XHJcbiAgICAgICAgICB2YXIgcmVzcG9uc2UgPSBpdGVtWzFdO1xyXG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xyXG4gICAgICAgICAgdmFyIHJlc3BvbnNlRW50cnkgPSByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJhc2U2NEVuY29kZWRSZXNwb25zZUJvZGllc1tpXSk7XHJcblxyXG4gICAgICAgICAgdmFyIHJlcXVlc3RVcmxOb1NlYXJjaCA9IG5ldyBVUkwocmVxdWVzdC51cmwsIGRvY3VtZW50LmxvY2F0aW9uKTtcclxuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaC5zZWFyY2ggPSAnJztcclxuICAgICAgICAgIC8vIHdvcmtpbmcgYXJvdW5kIENocm9tZSBidWdcclxuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaCA9IHJlcXVlc3RVcmxOb1NlYXJjaC5ocmVmLnJlcGxhY2UoL1xcPyQvLCAnJyk7XHJcblxyXG4gICAgICAgICAgdGhpcy5fZGVsZXRlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oKSB7XHJcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xyXG4gICAgICAgICAgICAgIG9yaWdpbjogb3JpZ2luLFxyXG4gICAgICAgICAgICAgIGNhY2hlTmFtZTogY2FjaGVOYW1lLFxyXG4gICAgICAgICAgICAgIHJlcXVlc3Q6IHJlcXVlc3RFbnRyeSxcclxuICAgICAgICAgICAgICByZXNwb25zZTogcmVzcG9uc2VFbnRyeSxcclxuICAgICAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2g6IHJlcXVlc3RVcmxOb1NlYXJjaCxcclxuICAgICAgICAgICAgICB2YXJ5SUQ6IGNyZWF0ZVZhcnlJRChyZXF1ZXN0RW50cnksIHJlc3BvbnNlRW50cnkpLFxyXG4gICAgICAgICAgICAgIGFkZGVkOiBEYXRlLm5vdygpXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgICAgIH0uYmluZCh0aGlzKSk7XHJcbiAgICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xyXG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZURCKCk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcclxudmFyIENhY2hlID0gcmVxdWlyZSgnLi9jYWNoZScpO1xyXG5cclxuZnVuY3Rpb24gQ2FjaGVTdG9yYWdlKCkge1xyXG4gIHRoaXMuX29yaWdpbiA9IGxvY2F0aW9uLm9yaWdpbjtcclxufVxyXG5cclxudmFyIENhY2hlU3RvcmFnZVByb3RvID0gQ2FjaGVTdG9yYWdlLnByb3RvdHlwZTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLl92ZW5kQ2FjaGUgPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgdmFyIGNhY2hlID0gbmV3IENhY2hlKCk7XHJcbiAgY2FjaGUuX25hbWUgPSBuYW1lO1xyXG4gIGNhY2hlLl9vcmlnaW4gPSB0aGlzLl9vcmlnaW47XHJcbiAgcmV0dXJuIGNhY2hlO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcclxuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyh0aGlzLl9vcmlnaW4sIHJlcXVlc3QsIHBhcmFtcyk7XHJcbn07XHJcblxyXG5DYWNoZVN0b3JhZ2VQcm90by5oYXMgPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIuaGFzQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLm9wZW4gPSBmdW5jdGlvbihuYW1lKSB7XHJcbiAgcmV0dXJuIGNhY2hlREIub3BlbkNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSkudGhlbihmdW5jdGlvbigpIHtcclxuICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XHJcbiAgfS5iaW5kKHRoaXMpKTtcclxufTtcclxuXHJcbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcclxuICByZXR1cm4gY2FjaGVEQi5kZWxldGVDYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpO1xyXG59O1xyXG5cclxuQ2FjaGVTdG9yYWdlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKCkge1xyXG4gIHJldHVybiBjYWNoZURCLmNhY2hlTmFtZXModGhpcy5fb3JpZ2luKTtcclxufTtcclxuXHJcbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlU3RvcmFnZSgpO1xyXG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XHJcbiAgdmFyIHJlcXVlc3QgPSAoc2VsZi5faW5kZXhlZERCIHx8IHNlbGYuaW5kZXhlZERCKS5vcGVuKG5hbWUsIHZlcnNpb24pO1xyXG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xyXG4gIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gZnVuY3Rpb24oZXZlbnQpIHtcclxuICAgIHVwZ3JhZGVDYWxsYmFjayhyZXF1ZXN0LnJlc3VsdCwgZXZlbnQub2xkVmVyc2lvbik7XHJcbiAgfTtcclxufVxyXG5cclxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdfaW5kZXhlZERCJyBpbiBzZWxmIHx8ICdpbmRleGVkREInIGluIHNlbGY7XHJcblxyXG5JREJIZWxwZXIucHJvbWlzaWZ5ID0gZnVuY3Rpb24ob2JqKSB7XHJcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xyXG4gICAgSURCSGVscGVyLmNhbGxiYWNraWZ5KG9iaiwgcmVzb2x2ZSwgcmVqZWN0KTtcclxuICB9KTtcclxufTtcclxuXHJcbklEQkhlbHBlci5jYWxsYmFja2lmeSA9IGZ1bmN0aW9uKG9iaiwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xyXG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xyXG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xyXG4gICAgICBkb25lQ2FsbGJhY2sob2JqLnJlc3VsdCk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIG9uZXJyb3IoZXZlbnQpIHtcclxuICAgIGlmIChlcnJDYWxsYmFjaykge1xyXG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xyXG4gICAgfVxyXG4gIH1cclxuICBvYmoub25jb21wbGV0ZSA9IG9uc3VjY2VzcztcclxuICBvYmoub25zdWNjZXNzID0gb25zdWNjZXNzO1xyXG4gIG9iai5vbmVycm9yID0gb25lcnJvcjtcclxuICBvYmoub25hYm9ydCA9IG9uZXJyb3I7XHJcbn07XHJcblxyXG5JREJIZWxwZXIuaXRlcmF0ZSA9IGZ1bmN0aW9uKGN1cnNvclJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XHJcbiAgdmFyIG9sZEN1cnNvckNvbnRpbnVlO1xyXG5cclxuICBmdW5jdGlvbiBjdXJzb3JDb250aW51ZSgpIHtcclxuICAgIHRoaXMuX2NvbnRpbnVpbmcgPSB0cnVlO1xyXG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XHJcbiAgfVxyXG5cclxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xyXG4gICAgdmFyIGN1cnNvciA9IGN1cnNvclJlcXVlc3QucmVzdWx0O1xyXG5cclxuICAgIGlmICghY3Vyc29yKSB7XHJcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcclxuICAgICAgICBkb25lQ2FsbGJhY2soKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKGN1cnNvci5jb250aW51ZSAhPSBjdXJzb3JDb250aW51ZSkge1xyXG4gICAgICBvbGRDdXJzb3JDb250aW51ZSA9IGN1cnNvci5jb250aW51ZTtcclxuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XHJcbiAgICB9XHJcblxyXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XHJcblxyXG4gICAgaWYgKCFjdXJzb3IuX2NvbnRpbnVpbmcpIHtcclxuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xyXG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfTtcclxuXHJcbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XHJcbiAgICBpZiAoZXJyb3JDYWxsYmFjaykge1xyXG4gICAgICBlcnJvckNhbGxiYWNrKGN1cnNvclJlcXVlc3QuZXJyb3IpO1xyXG4gICAgfVxyXG4gIH07XHJcbn07XHJcblxyXG52YXIgSURCSGVscGVyUHJvdG8gPSBJREJIZWxwZXIucHJvdG90eXBlO1xyXG5cclxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XHJcbiAgb3B0cyA9IG9wdHMgfHwge307XHJcblxyXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcclxuICAgIHZhciBtb2RlID0gb3B0cy5tb2RlIHx8ICdyZWFkb25seSc7XHJcblxyXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcclxuICAgIGNhbGxiYWNrKHR4LCBkYik7XHJcbiAgICByZXR1cm4gSURCSGVscGVyLnByb21pc2lmeSh0eCk7XHJcbiAgfSk7XHJcbn07XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiXX0=
