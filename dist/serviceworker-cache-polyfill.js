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
  var body;
  try {
    body = decodeURIComponent(escape(atob(entryResponse.body)));
  }
  catch(e) {
    body = atob(entryResponse.body);
  }
  return new Response(body, {
    status: entryResponse.status,
    statusText: entryResponse.statusText,
    headers: entryResponse.headers
  });
}

function responseToEntry(response, body) {
  return {
    body: btoa(unescape(encodeURIComponent(body))),
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
      return item[1].text();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuL2J1aWxkL2luZGV4LmpzIiwiL1VzZXJzL2Jyb3RoL1Byb2plY3RzL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZS5qcyIsIi9Vc2Vycy9icm90aC9Qcm9qZWN0cy9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGVkYi5qcyIsIi9Vc2Vycy9icm90aC9Qcm9qZWN0cy9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGVzLmpzIiwiL1VzZXJzL2Jyb3RoL1Byb2plY3RzL2NhY2hlLXBvbHlmaWxsL2xpYi9pZGJoZWxwZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlhQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsImlmKCF3aW5kb3cuY2FjaGVzKSB3aW5kb3cuY2FjaGVzID0gcmVxdWlyZSgnLi4vbGliL2NhY2hlcy5qcycpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG5cbmZ1bmN0aW9uIENhY2hlKCkge1xuICB0aGlzLl9uYW1lID0gJyc7XG4gIHRoaXMuX29yaWdpbiA9ICcnO1xufVxuXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcblxuQ2FjaGVQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWxsKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICByZXR1cm4gZmV0Y2gocmVxdWVzdCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xuICAgIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcbiAgICAgIHJldHVybiBbcmVxdWVzdHNbaV0sIHJlc3BvbnNlXTtcbiAgICB9KSk7XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVByb3RvLmFkZCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XG59O1xuXG5DYWNoZVByb3RvLnB1dCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlKSB7XG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XG4gICAgdGhyb3cgVHlwZUVycm9yKFwiSW5jb3JyZWN0IHJlc3BvbnNlIHR5cGVcIik7XG4gIH1cblxuICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCBbW3JlcXVlc3QsIHJlc3BvbnNlXV0pO1xufTtcblxuQ2FjaGVQcm90by5kZWxldGUgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICBpZiAocmVxdWVzdCkge1xuICAgIHJldHVybiBjYWNoZURCLm1hdGNoQWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xuICB9XG4gIGVsc2Uge1xuICAgIHJldHVybiBjYWNoZURCLmFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSk7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQ2FjaGU7XG4iLCJ2YXIgSURCSGVscGVyID0gcmVxdWlyZSgnLi9pZGJoZWxwZXInKTtcblxuZnVuY3Rpb24gbWF0Y2hlc1ZhcnkocmVxdWVzdCwgZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG4gIHZhciByZXF1ZXN0SGVhZGVycyA9IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycyk7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICB2YXIgaWQgPSAnJztcblxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XG4gIH1cblxuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xuXG4gIGhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbiAodmFsdWUsIG5hbWUpIHtcbiAgICByZXR1cm5WYWxbbmFtZS50b0xvd2VyQ2FzZSgpXSA9IHZhbHVlO1xuICB9KTtcblxuICByZXR1cm4gcmV0dXJuVmFsO1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVzcG9uc2UoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVzcG9uc2UgPSBlbnRyeS5yZXNwb25zZTtcbiAgdmFyIGJvZHk7XG4gIHRyeSB7XG4gICAgYm9keSA9IGRlY29kZVVSSUNvbXBvbmVudChlc2NhcGUoYXRvYihlbnRyeVJlc3BvbnNlLmJvZHkpKSk7XG4gIH1cbiAgY2F0Y2goZSkge1xuICAgIGJvZHkgPSBhdG9iKGVudHJ5UmVzcG9uc2UuYm9keSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShib2R5LCB7XG4gICAgc3RhdHVzOiBlbnRyeVJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZW50cnlSZXNwb25zZS5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJvZHkpIHtcbiAgcmV0dXJuIHtcbiAgICBib2R5OiBidG9hKHVuZXNjYXBlKGVuY29kZVVSSUNvbXBvbmVudChib2R5KSkpLFxuICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVzcG9uc2UuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1JlcXVlc3QoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XG4gIHJldHVybiBuZXcgUmVxdWVzdChlbnRyeVJlcXVlc3QudXJsLCB7XG4gICAgbW9kZTogZW50cnlSZXF1ZXN0Lm1vZGUsXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXG4gICAgY3JlZGVudGlhbHM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KSB7XG4gIHJldHVybiB7XG4gICAgdXJsOiByZXF1ZXN0LnVybC50b1N0cmluZygpLFxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcbiAgICBjcmVkZW50aWFsczogcmVxdWVzdC5jcmVkZW50aWFscyxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xuICBpZiAoIShyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkpIHtcbiAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmZ1bmN0aW9uIENhY2hlREIoKSB7XG4gIHRoaXMuZGIgPSBuZXcgSURCSGVscGVyKCdjYWNoZS1wb2x5ZmlsbCcsIDEsIGZ1bmN0aW9uKGRiLCBvbGRWZXJzaW9uKSB7XG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHZhciBuYW1lc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXG4gICAgICAgIH0pO1xuICAgICAgICBuYW1lc1N0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4nLCBbJ29yaWdpbicsICdhZGRlZCddKTtcblxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ3ZhcnlJRCddXG4gICAgICAgIH0pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3RVcmxOb1NlYXJjaCcsICdhZGRlZCddKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xuXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIElEQkhlbHBlci5pdGVyYXRlKFxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxuICAgIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrXG4gICk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2VhY2hNYXRjaCA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XG5cbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XG5cbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gIHZhciByYW5nZTtcbiAgdmFyIGluZGV4O1xuICB2YXIgaW5kZXhOYW1lID0gJ29yaWdpbi1jYWNoZU5hbWUtdXJsJztcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsLCBkb2N1bWVudC5sb2NhdGlvbik7XG5cbiAgdXJsVG9NYXRjaC5oYXNoID0gJyc7XG5cbiAgaWYgKGlnbm9yZVNlYXJjaCkge1xuICAgIHVybFRvTWF0Y2guc2VhcmNoID0gJyc7XG4gICAgaW5kZXhOYW1lICs9ICdOb1NlYXJjaCc7XG4gIH1cblxuICAvLyB3b3JraW5nIGFyb3VuZCBjaHJvbWUgYnVnc1xuICB1cmxUb01hdGNoID0gdXJsVG9NYXRjaC5ocmVmLnJlcGxhY2UoLyhcXD98I3xcXD8jKSQvLCAnJyk7XG5cbiAgaW5kZXggPSBjYWNoZUVudHJpZXMuaW5kZXgoaW5kZXhOYW1lKTtcblxuICBpZiAocHJlZml4TWF0Y2gpIHtcbiAgICByYW5nZSA9IElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgdXJsVG9NYXRjaCArIFN0cmluZy5mcm9tQ2hhckNvZGUoNjU1MzUpLCBJbmZpbml0eV0pO1xuICB9XG4gIGVsc2Uge1xuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCBJbmZpbml0eV0pO1xuICB9XG5cbiAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihyYW5nZSksIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHZhciB2YWx1ZSA9IGN1cnNvci52YWx1ZTtcblxuICAgIGlmIChpZ25vcmVWYXJ5IHx8IG1hdGNoZXNWYXJ5KHJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXF1ZXN0LCBjdXJzb3IudmFsdWUucmVzcG9uc2UpKSB7XG4gICAgICAvLyBpdCdzIGRvd24gdG8gdGhlIGNhbGxiYWNrIHRvIGNhbGwgY3Vyc29yLmNvbnRpbnVlKClcbiAgICAgIGVhY2hDYWxsYmFjayhjdXJzb3IpO1xuICAgIH1cbiAgfSwgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5faGFzQ2FjaGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgdmFyIHN0b3JlID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnKTtcbiAgcmV0dXJuIElEQkhlbHBlci5jYWxsYmFja2lmeShzdG9yZS5nZXQoW29yaWdpbiwgY2FjaGVOYW1lXSksIGZ1bmN0aW9uKHZhbCkge1xuICAgIGRvbmVDYWxsYmFjayghIXZhbCk7XG4gIH0sIGVyckNhbGxiYWNrKTtcbn07XG5cbkNhY2hlREJQcm90by5fZGVsZXRlID0gZnVuY3Rpb24odHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrLCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgIHJldHVyblZhbCA9IHRydWU7XG4gICAgY3Vyc29yLmRlbGV0ZSgpO1xuICAgIGN1cnNvci5jb250aW51ZSgpO1xuICB9LCBmdW5jdGlvbigpIHtcbiAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICBkb25lQ2FsbGJhY2socmV0dXJuVmFsKTtcbiAgICB9XG4gIH0sIGVyckNhbGxiYWNrLCBwYXJhbXMpO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLmtleSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaGVzLm1hcChlbnRyeVRvUmVxdWVzdCk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmFsbFJlcXVlc3RzID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB2YXIgY2FjaGVFbnRyaWVzID0gdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpO1xuICAgIHZhciBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoaW5kZXgub3BlbkN1cnNvcihJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIEluZmluaXR5XSkpLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSk7XG4gIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGwgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaGVzID0gW107XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaGVzLnB1c2goY3Vyc29yLnZhbHVlKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXNwb25zZSk7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlRW50cmllcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBtYXRjaCA9IGN1cnNvci52YWx1ZTtcbiAgICB9LCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgcGFyYW1zKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm1hdGNoQWNyb3NzQ2FjaGVzID0gZnVuY3Rpb24ob3JpZ2luLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24obmFtZXNDdXJzb3IpIHtcbiAgICAgIHZhciBjYWNoZU5hbWUgPSBuYW1lc0N1cnNvci52YWx1ZS5uYW1lO1xuXG4gICAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbiBlYWNoKHJlc3BvbnNlQ3Vyc29yKSB7XG4gICAgICAgIG1hdGNoID0gcmVzcG9uc2VDdXJzb3IudmFsdWU7XG4gICAgICB9LCBmdW5jdGlvbiBkb25lKCkge1xuICAgICAgICBpZiAoIW1hdGNoKSB7XG4gICAgICAgICAgbmFtZXNDdXJzb3IuY29udGludWUoKTtcbiAgICAgICAgfVxuICAgICAgfSwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2ggPyBlbnRyeVRvUmVzcG9uc2UobWF0Y2gpIDogdW5kZWZpbmVkO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5jYWNoZU5hbWVzID0gZnVuY3Rpb24ob3JpZ2luKSB7XG4gIHZhciBuYW1lcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoQ2FjaGUodHgsIG9yaWdpbiwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgICBuYW1lcy5wdXNoKGN1cnNvci52YWx1ZS5uYW1lKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbmFtZXM7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIHJldHVyblZhbDtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMsIGZ1bmN0aW9uKHYpIHtcbiAgICAgIHJldHVyblZhbCA9IHY7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5vcGVuQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIGlmICh2YWwpIHsgcmV0dXJuOyB9XG4gICAgICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICAgICAgc3RvcmUuYWRkKHtcbiAgICAgICAgb3JpZ2luOiBvcmlnaW4sXG4gICAgICAgIG5hbWU6IGNhY2hlTmFtZSxcbiAgICAgICAgYWRkZWQ6IERhdGUubm93KClcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xufTtcblxuQ2FjaGVEQlByb3RvLmhhc0NhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbDtcbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24odmFsKSB7XG4gICAgICByZXR1cm5WYWwgPSB2YWw7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbih2YWwpIHtcbiAgICByZXR1cm4gcmV0dXJuVmFsO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5kZWxldGVDYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHZhciByZXR1cm5WYWwgPSBmYWxzZTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbihbJ2NhY2hlRW50cmllcycsICdjYWNoZU5hbWVzJ10sIGZ1bmN0aW9uKHR4KSB7XG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2Uub25seShbb3JpZ2luLCBjYWNoZU5hbWVdKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgSURCSGVscGVyLml0ZXJhdGUoXG4gICAgICB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJykuaW5kZXgoJ29yaWdpbi1jYWNoZU5hbWUnKS5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksXG4gICAgICBkZWxcbiAgICApO1xuXG4gICAgZnVuY3Rpb24gZGVsKGN1cnNvcikge1xuICAgICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5kZWxldGUoKTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH1cbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLnB1dCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCBpdGVtcykge1xuICAvLyBpdGVtcyBpcyBbW3JlcXVlc3QsIHJlc3BvbnNlXSwgW3JlcXVlc3QsIHJlc3BvbnNlXSwg4oCmXVxuICB2YXIgaXRlbTtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGl0ZW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgaXRlbXNbaV1bMF0gPSBjYXN0VG9SZXF1ZXN0KGl0ZW1zW2ldWzBdKTtcblxuICAgIGlmIChpdGVtc1tpXVswXS5tZXRob2QgIT0gJ0dFVCcpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoJ09ubHkgR0VUIHJlcXVlc3RzIGFyZSBzdXBwb3J0ZWQnKSk7XG4gICAgfVxuXG4gICAgaWYgKGl0ZW1zW2ldWzFdLnR5cGUgPT0gJ29wYXF1ZScpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChUeXBlRXJyb3IoXCJUaGUgcG9seWZpbGwgZG9lc24ndCBzdXBwb3J0IG9wYXF1ZSByZXNwb25zZXMgKGZyb20gY3Jvc3Mtb3JpZ2luIG5vLWNvcnMgcmVxdWVzdHMpXCIpKTtcbiAgICB9XG5cbiAgICAvLyBlbnN1cmUgZWFjaCBlbnRyeSBiZWluZyBwdXQgd29uJ3Qgb3ZlcndyaXRlIGVhcmxpZXIgZW50cmllcyBiZWluZyBwdXRcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgaWYgKGl0ZW1zW2ldWzBdLnVybCA9PSBpdGVtc1tqXVswXS51cmwgJiYgbWF0Y2hlc1ZhcnkoaXRlbXNbal1bMF0sIGl0ZW1zW2ldWzBdLCBpdGVtc1tpXVsxXSkpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignUHV0cyB3b3VsZCBvdmVyd3JpdGUgZWFjaG90aGVyJykpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChcbiAgICBpdGVtcy5tYXAoZnVuY3Rpb24oaXRlbSkge1xuICAgICAgcmV0dXJuIGl0ZW1bMV0udGV4dCgpO1xuICAgIH0pXG4gICkudGhlbihmdW5jdGlvbihyZXNwb25zZUJvZGllcykge1xuICAgIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICAgIHRoaXMuX2hhc0NhY2hlKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZnVuY3Rpb24oaGFzQ2FjaGUpIHtcbiAgICAgICAgaWYgKCFoYXNDYWNoZSkge1xuICAgICAgICAgIHRocm93IEVycm9yKFwiQ2FjaGUgb2YgdGhhdCBuYW1lIGRvZXMgbm90IGV4aXN0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtLCBpKSB7XG4gICAgICAgICAgdmFyIHJlcXVlc3QgPSBpdGVtWzBdO1xuICAgICAgICAgIHZhciByZXNwb25zZSA9IGl0ZW1bMV07XG4gICAgICAgICAgdmFyIHJlcXVlc3RFbnRyeSA9IHJlcXVlc3RUb0VudHJ5KHJlcXVlc3QpO1xuICAgICAgICAgIHZhciByZXNwb25zZUVudHJ5ID0gcmVzcG9uc2VUb0VudHJ5KHJlc3BvbnNlLCByZXNwb25zZUJvZGllc1tpXSk7XG5cbiAgICAgICAgICB2YXIgcmVxdWVzdFVybE5vU2VhcmNoID0gbmV3IFVSTChyZXF1ZXN0LnVybCwgZG9jdW1lbnQubG9jYXRpb24pO1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaC5zZWFyY2ggPSAnJztcbiAgICAgICAgICAvLyB3b3JraW5nIGFyb3VuZCBDaHJvbWUgYnVnXG4gICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoID0gcmVxdWVzdFVybE5vU2VhcmNoLmhyZWYucmVwbGFjZSgvXFw/JC8sICcnKTtcblxuICAgICAgICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdHgub2JqZWN0U3RvcmUoJ2NhY2hlRW50cmllcycpLmFkZCh7XG4gICAgICAgICAgICAgIG9yaWdpbjogb3JpZ2luLFxuICAgICAgICAgICAgICBjYWNoZU5hbWU6IGNhY2hlTmFtZSxcbiAgICAgICAgICAgICAgcmVxdWVzdDogcmVxdWVzdEVudHJ5LFxuICAgICAgICAgICAgICByZXNwb25zZTogcmVzcG9uc2VFbnRyeSxcbiAgICAgICAgICAgICAgcmVxdWVzdFVybE5vU2VhcmNoOiByZXF1ZXN0VXJsTm9TZWFyY2gsXG4gICAgICAgICAgICAgIHZhcnlJRDogY3JlYXRlVmFyeUlEKHJlcXVlc3RFbnRyeSwgcmVzcG9uc2VFbnRyeSksXG4gICAgICAgICAgICAgIGFkZGVkOiBEYXRlLm5vdygpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICB9LmJpbmQodGhpcykpO1xuICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IG5ldyBDYWNoZURCKCk7IiwidmFyIGNhY2hlREIgPSByZXF1aXJlKCcuL2NhY2hlZGInKTtcbnZhciBDYWNoZSA9IHJlcXVpcmUoJy4vY2FjaGUnKTtcblxuZnVuY3Rpb24gQ2FjaGVTdG9yYWdlKCkge1xuICB0aGlzLl9vcmlnaW4gPSBsb2NhdGlvbi5vcmlnaW47XG59XG5cbnZhciBDYWNoZVN0b3JhZ2VQcm90byA9IENhY2hlU3RvcmFnZS5wcm90b3R5cGU7XG5cbkNhY2hlU3RvcmFnZVByb3RvLl92ZW5kQ2FjaGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHZhciBjYWNoZSA9IG5ldyBDYWNoZSgpO1xuICBjYWNoZS5fbmFtZSA9IG5hbWU7XG4gIGNhY2hlLl9vcmlnaW4gPSB0aGlzLl9vcmlnaW47XG4gIHJldHVybiBjYWNoZTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLm1hdGNoID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWNyb3NzQ2FjaGVzKHRoaXMuX29yaWdpbiwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmhhcyA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuaGFzQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLm9wZW4gPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLm9wZW5DYWNoZSh0aGlzLl9vcmlnaW4sIG5hbWUpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuX3ZlbmRDYWNoZShuYW1lKTtcbiAgfS5iaW5kKHRoaXMpKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmRlbGV0ZSA9IGZ1bmN0aW9uKG5hbWUpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKTtcbn07XG5cbkNhY2hlU3RvcmFnZVByb3RvLmtleXMgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGNhY2hlREIuY2FjaGVOYW1lcyh0aGlzLl9vcmlnaW4pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVTdG9yYWdlKCk7XG4iLCJmdW5jdGlvbiBJREJIZWxwZXIobmFtZSwgdmVyc2lvbiwgdXBncmFkZUNhbGxiYWNrKSB7XG4gIHZhciByZXF1ZXN0ID0gKHNlbGYuX2luZGV4ZWREQiB8fCBzZWxmLmluZGV4ZWREQikub3BlbihuYW1lLCB2ZXJzaW9uKTtcbiAgdGhpcy5yZWFkeSA9IElEQkhlbHBlci5wcm9taXNpZnkocmVxdWVzdCk7XG4gIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gZnVuY3Rpb24oZXZlbnQpIHtcbiAgICB1cGdyYWRlQ2FsbGJhY2socmVxdWVzdC5yZXN1bHQsIGV2ZW50Lm9sZFZlcnNpb24pO1xuICB9O1xufVxuXG5JREJIZWxwZXIuc3VwcG9ydGVkID0gJ19pbmRleGVkREInIGluIHNlbGYgfHwgJ2luZGV4ZWREQicgaW4gc2VsZjtcblxuSURCSGVscGVyLnByb21pc2lmeSA9IGZ1bmN0aW9uKG9iaikge1xuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgSURCSGVscGVyLmNhbGxiYWNraWZ5KG9iaiwgcmVzb2x2ZSwgcmVqZWN0KTtcbiAgfSk7XG59O1xuXG5JREJIZWxwZXIuY2FsbGJhY2tpZnkgPSBmdW5jdGlvbihvYmosIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2spIHtcbiAgZnVuY3Rpb24gb25zdWNjZXNzKGV2ZW50KSB7XG4gICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgZG9uZUNhbGxiYWNrKG9iai5yZXN1bHQpO1xuICAgIH1cbiAgfVxuICBmdW5jdGlvbiBvbmVycm9yKGV2ZW50KSB7XG4gICAgaWYgKGVyckNhbGxiYWNrKSB7XG4gICAgICBlcnJDYWxsYmFjayhvYmouZXJyb3IpO1xuICAgIH1cbiAgfVxuICBvYmoub25jb21wbGV0ZSA9IG9uc3VjY2VzcztcbiAgb2JqLm9uc3VjY2VzcyA9IG9uc3VjY2VzcztcbiAgb2JqLm9uZXJyb3IgPSBvbmVycm9yO1xuICBvYmoub25hYm9ydCA9IG9uZXJyb3I7XG59O1xuXG5JREJIZWxwZXIuaXRlcmF0ZSA9IGZ1bmN0aW9uKGN1cnNvclJlcXVlc3QsIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIHZhciBvbGRDdXJzb3JDb250aW51ZTtcblxuICBmdW5jdGlvbiBjdXJzb3JDb250aW51ZSgpIHtcbiAgICB0aGlzLl9jb250aW51aW5nID0gdHJ1ZTtcbiAgICByZXR1cm4gb2xkQ3Vyc29yQ29udGludWUuY2FsbCh0aGlzKTtcbiAgfVxuXG4gIGN1cnNvclJlcXVlc3Qub25zdWNjZXNzID0gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGN1cnNvciA9IGN1cnNvclJlcXVlc3QucmVzdWx0O1xuXG4gICAgaWYgKCFjdXJzb3IpIHtcbiAgICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgICAgZG9uZUNhbGxiYWNrKCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKGN1cnNvci5jb250aW51ZSAhPSBjdXJzb3JDb250aW51ZSkge1xuICAgICAgb2xkQ3Vyc29yQ29udGludWUgPSBjdXJzb3IuY29udGludWU7XG4gICAgICBjdXJzb3IuY29udGludWUgPSBjdXJzb3JDb250aW51ZTtcbiAgICB9XG5cbiAgICBlYWNoQ2FsbGJhY2soY3Vyc29yKTtcblxuICAgIGlmICghY3Vyc29yLl9jb250aW51aW5nKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjdXJzb3JSZXF1ZXN0Lm9uZXJyb3IgPSBmdW5jdGlvbigpIHtcbiAgICBpZiAoZXJyb3JDYWxsYmFjaykge1xuICAgICAgZXJyb3JDYWxsYmFjayhjdXJzb3JSZXF1ZXN0LmVycm9yKTtcbiAgICB9XG4gIH07XG59O1xuXG52YXIgSURCSGVscGVyUHJvdG8gPSBJREJIZWxwZXIucHJvdG90eXBlO1xuXG5JREJIZWxwZXJQcm90by50cmFuc2FjdGlvbiA9IGZ1bmN0aW9uKHN0b3JlcywgY2FsbGJhY2ssIG9wdHMpIHtcbiAgb3B0cyA9IG9wdHMgfHwge307XG5cbiAgcmV0dXJuIHRoaXMucmVhZHkudGhlbihmdW5jdGlvbihkYikge1xuICAgIHZhciBtb2RlID0gb3B0cy5tb2RlIHx8ICdyZWFkb25seSc7XG5cbiAgICB2YXIgdHggPSBkYi50cmFuc2FjdGlvbihzdG9yZXMsIG1vZGUpO1xuICAgIGNhbGxiYWNrKHR4LCBkYik7XG4gICAgcmV0dXJuIElEQkhlbHBlci5wcm9taXNpZnkodHgpO1xuICB9KTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gSURCSGVscGVyOyJdfQ==
