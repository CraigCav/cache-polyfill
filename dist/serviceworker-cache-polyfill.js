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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuL2J1aWxkL2luZGV4LmpzIiwiL1VzZXJzL2Jyb3RoL1Byb2plY3RzL2NhY2hlLXBvbHlmaWxsL2xpYi9jYWNoZS5qcyIsIi9Vc2Vycy9icm90aC9Qcm9qZWN0cy9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGVkYi5qcyIsIi9Vc2Vycy9icm90aC9Qcm9qZWN0cy9jYWNoZS1wb2x5ZmlsbC9saWIvY2FjaGVzLmpzIiwiL1VzZXJzL2Jyb3RoL1Byb2plY3RzL2NhY2hlLXBvbHlmaWxsL2xpYi9pZGJoZWxwZXIuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlhQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsImlmKCF3aW5kb3cuY2FjaGVzKSB3aW5kb3cuY2FjaGVzID0gcmVxdWlyZSgnLi4vbGliL2NhY2hlcy5qcycpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG5cbmZ1bmN0aW9uIENhY2hlKCkge1xuICB0aGlzLl9uYW1lID0gJyc7XG4gIHRoaXMuX29yaWdpbiA9ICcnO1xufVxuXG52YXIgQ2FjaGVQcm90byA9IENhY2hlLnByb3RvdHlwZTtcblxuQ2FjaGVQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVByb3RvLm1hdGNoQWxsID0gZnVuY3Rpb24ocmVxdWVzdCwgcGFyYW1zKSB7XG4gIHJldHVybiBjYWNoZURCLm1hdGNoQWxsKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8uYWRkQWxsID0gZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICByZXR1cm4gZmV0Y2gocmVxdWVzdCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xuICAgIHJldHVybiBjYWNoZURCLnB1dCh0aGlzLl9vcmlnaW4sIHRoaXMuX25hbWUsIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcbiAgICAgIHJldHVybiBbcmVxdWVzdHNbaV0sIHJlc3BvbnNlXTtcbiAgICB9KSk7XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVByb3RvLmFkZCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgcmV0dXJuIHRoaXMuYWRkQWxsKFtyZXF1ZXN0XSk7XG59O1xuXG5DYWNoZVByb3RvLnB1dCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHJlc3BvbnNlKSB7XG4gIGlmICghKHJlc3BvbnNlIGluc3RhbmNlb2YgUmVzcG9uc2UpKSB7XG4gICAgdGhyb3cgVHlwZUVycm9yKFwiSW5jb3JyZWN0IHJlc3BvbnNlIHR5cGVcIik7XG4gIH1cblxuICByZXR1cm4gY2FjaGVEQi5wdXQodGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCBbW3JlcXVlc3QsIHJlc3BvbnNlXV0pO1xufTtcblxuQ2FjaGVQcm90by5kZWxldGUgPSBmdW5jdGlvbihyZXF1ZXN0LCBwYXJhbXMpIHtcbiAgcmV0dXJuIGNhY2hlREIuZGVsZXRlKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSwgcmVxdWVzdCwgcGFyYW1zKTtcbn07XG5cbkNhY2hlUHJvdG8ua2V5cyA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICBpZiAocmVxdWVzdCkge1xuICAgIHJldHVybiBjYWNoZURCLm1hdGNoQWxsUmVxdWVzdHModGhpcy5fb3JpZ2luLCB0aGlzLl9uYW1lLCByZXF1ZXN0LCBwYXJhbXMpO1xuICB9XG4gIGVsc2Uge1xuICAgIHJldHVybiBjYWNoZURCLmFsbFJlcXVlc3RzKHRoaXMuX29yaWdpbiwgdGhpcy5fbmFtZSk7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQ2FjaGU7XG4iLCJ2YXIgSURCSGVscGVyID0gcmVxdWlyZSgnLi9pZGJoZWxwZXInKTtcblxuZnVuY3Rpb24gbWF0Y2hlc1ZhcnkocmVxdWVzdCwgZW50cnlSZXF1ZXN0LCBlbnRyeVJlc3BvbnNlKSB7XG4gIGlmICghZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHZhciB2YXJ5SGVhZGVycyA9IGVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5LnRvTG93ZXJDYXNlKCkuc3BsaXQoJywnKTtcbiAgdmFyIHZhcnlIZWFkZXI7XG4gIHZhciByZXF1ZXN0SGVhZGVycyA9IGZsYXR0ZW5IZWFkZXJzKHJlcXVlc3QuaGVhZGVycyk7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB2YXJ5SGVhZGVycy5sZW5ndGg7IGkrKykge1xuICAgIHZhcnlIZWFkZXIgPSB2YXJ5SGVhZGVyc1tpXS50cmltKCk7XG5cbiAgICBpZiAodmFyeUhlYWRlciA9PSAnKicpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChlbnRyeVJlcXVlc3QuaGVhZGVyc1t2YXJ5SGVhZGVyXSAhPSByZXF1ZXN0SGVhZGVyc1t2YXJ5SGVhZGVyXSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVmFyeUlEKGVudHJ5UmVxdWVzdCwgZW50cnlSZXNwb25zZSkge1xuICB2YXIgaWQgPSAnJztcblxuICBpZiAoIWVudHJ5UmVzcG9uc2UuaGVhZGVycy52YXJ5KSB7XG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgdmFyIHZhcnlIZWFkZXJzID0gZW50cnlSZXNwb25zZS5oZWFkZXJzLnZhcnkudG9Mb3dlckNhc2UoKS5zcGxpdCgnLCcpO1xuICB2YXIgdmFyeUhlYWRlcjtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHZhcnlIZWFkZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyeUhlYWRlciA9IHZhcnlIZWFkZXJzW2ldLnRyaW0oKTtcblxuICAgIGlmICh2YXJ5SGVhZGVyID09ICcqJykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWQgKz0gdmFyeUhlYWRlciArICc6ICcgKyAoZW50cnlSZXF1ZXN0LmhlYWRlcnNbdmFyeUhlYWRlcl0gfHwgJycpICsgJ1xcbic7XG4gIH1cblxuICByZXR1cm4gaWQ7XG59XG5cbmZ1bmN0aW9uIGZsYXR0ZW5IZWFkZXJzKGhlYWRlcnMpIHtcbiAgdmFyIHJldHVyblZhbCA9IHt9O1xuXG4gIGhlYWRlcnMuZm9yRWFjaChmdW5jdGlvbiAodmFsdWUsIG5hbWUpIHtcbiAgICByZXR1cm5WYWxbbmFtZS50b0xvd2VyQ2FzZSgpXSA9IHZhbHVlO1xuICB9KTtcblxuICByZXR1cm4gcmV0dXJuVmFsO1xufVxuXG5mdW5jdGlvbiBlbnRyeVRvUmVzcG9uc2UoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVzcG9uc2UgPSBlbnRyeS5yZXNwb25zZTtcbiAgdmFyIGJvZHk7XG4gIHRyeSB7XG4gICAgYm9keSA9IGRlY29kZVVSSUNvbXBvbmVudChlc2NhcGUoYXRvYihlbnRyeVJlc3BvbnNlLmJvZHkpKSk7XG4gIH1cbiAgY2F0Y2goZSkge1xuICAgIGJvZHkgPSBhdG9iKGVudHJ5UmVzcG9uc2UuYm9keSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBSZXNwb25zZShib2R5LCB7XG4gICAgc3RhdHVzOiBlbnRyeVJlc3BvbnNlLnN0YXR1cyxcbiAgICBzdGF0dXNUZXh0OiBlbnRyeVJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZW50cnlSZXNwb25zZS5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIGJvZHkpIHtcbiAgcmV0dXJuIHtcbiAgICBib2R5OiBidG9hKHVuZXNjYXBlKGVuY29kZVVSSUNvbXBvbmVudChib2R5KSkpLFxuICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLFxuICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsXG4gICAgaGVhZGVyczogZmxhdHRlbkhlYWRlcnMocmVzcG9uc2UuaGVhZGVycylcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW50cnlUb1JlcXVlc3QoZW50cnkpIHtcbiAgdmFyIGVudHJ5UmVxdWVzdCA9IGVudHJ5LnJlcXVlc3Q7XG4gIHJldHVybiBuZXcgUmVxdWVzdChlbnRyeVJlcXVlc3QudXJsLCB7XG4gICAgbW9kZTogZW50cnlSZXF1ZXN0Lm1vZGUsXG4gICAgaGVhZGVyczogZW50cnlSZXF1ZXN0LmhlYWRlcnMsXG4gICAgY3JlZGVudGlhbHM6IGVudHJ5UmVxdWVzdC5oZWFkZXJzXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1ZXN0VG9FbnRyeShyZXF1ZXN0KSB7XG4gIHJldHVybiB7XG4gICAgdXJsOiByZXF1ZXN0LnVybC50b1N0cmluZygpLFxuICAgIG1vZGU6IHJlcXVlc3QubW9kZSxcbiAgICBjcmVkZW50aWFsczogcmVxdWVzdC5jcmVkZW50aWFscyxcbiAgICBoZWFkZXJzOiBmbGF0dGVuSGVhZGVycyhyZXF1ZXN0LmhlYWRlcnMpXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNhc3RUb1JlcXVlc3QocmVxdWVzdCkge1xuICBpZiAoIShyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkpIHtcbiAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmZ1bmN0aW9uIENhY2hlREIoKSB7XG4gIHRoaXMuZGIgPSBuZXcgSURCSGVscGVyKCdjYWNoZS1wb2x5ZmlsbCcsIDEsIGZ1bmN0aW9uKGRiLCBvbGRWZXJzaW9uKSB7XG4gICAgc3dpdGNoIChvbGRWZXJzaW9uKSB7XG4gICAgICBjYXNlIDA6XG4gICAgICAgIHZhciBuYW1lc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoJ2NhY2hlTmFtZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnbmFtZSddXG4gICAgICAgIH0pO1xuICAgICAgICBuYW1lc1N0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4nLCBbJ29yaWdpbicsICdhZGRlZCddKTtcblxuICAgICAgICB2YXIgZW50cnlTdG9yZSA9IGRiLmNyZWF0ZU9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnLCB7XG4gICAgICAgICAga2V5UGF0aDogWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3QudXJsJywgJ3ZhcnlJRCddXG4gICAgICAgIH0pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ2FkZGVkJ10pO1xuICAgICAgICBlbnRyeVN0b3JlLmNyZWF0ZUluZGV4KCdvcmlnaW4tY2FjaGVOYW1lLXVybE5vU2VhcmNoJywgWydvcmlnaW4nLCAnY2FjaGVOYW1lJywgJ3JlcXVlc3RVcmxOb1NlYXJjaCcsICdhZGRlZCddKTtcbiAgICAgICAgZW50cnlTdG9yZS5jcmVhdGVJbmRleCgnb3JpZ2luLWNhY2hlTmFtZS11cmwnLCBbJ29yaWdpbicsICdjYWNoZU5hbWUnLCAncmVxdWVzdC51cmwnLCAnYWRkZWQnXSk7XG4gICAgfVxuICB9KTtcbn1cblxudmFyIENhY2hlREJQcm90byA9IENhY2hlREIucHJvdG90eXBlO1xuXG5DYWNoZURCUHJvdG8uX2VhY2hDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrKSB7XG4gIElEQkhlbHBlci5pdGVyYXRlKFxuICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykuaW5kZXgoJ29yaWdpbicpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgMF0sIFtvcmlnaW4sIEluZmluaXR5XSkpLFxuICAgIGVhY2hDYWxsYmFjaywgZG9uZUNhbGxiYWNrLCBlcnJvckNhbGxiYWNrXG4gICk7XG59O1xuXG5DYWNoZURCUHJvdG8uX2VhY2hNYXRjaCA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZWFjaENhbGxiYWNrLCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2ssIHBhcmFtcykge1xuICBwYXJhbXMgPSBwYXJhbXMgfHwge307XG5cbiAgdmFyIGlnbm9yZVNlYXJjaCA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVNlYXJjaCk7XG4gIHZhciBpZ25vcmVNZXRob2QgPSBCb29sZWFuKHBhcmFtcy5pZ25vcmVNZXRob2QpO1xuICB2YXIgaWdub3JlVmFyeSA9IEJvb2xlYW4ocGFyYW1zLmlnbm9yZVZhcnkpO1xuICB2YXIgcHJlZml4TWF0Y2ggPSBCb29sZWFuKHBhcmFtcy5wcmVmaXhNYXRjaCk7XG5cbiAgaWYgKCFpZ25vcmVNZXRob2QgJiZcbiAgICAgIHJlcXVlc3QubWV0aG9kICE9PSAnR0VUJyAmJlxuICAgICAgcmVxdWVzdC5tZXRob2QgIT09ICdIRUFEJykge1xuICAgIC8vIHdlIG9ubHkgc3RvcmUgR0VUIHJlc3BvbnNlcyBhdCB0aGUgbW9tZW50LCBzbyBubyBtYXRjaFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gIHZhciByYW5nZTtcbiAgdmFyIGluZGV4O1xuICB2YXIgaW5kZXhOYW1lID0gJ29yaWdpbi1jYWNoZU5hbWUtdXJsJztcbiAgdmFyIHVybFRvTWF0Y2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcblxuICB1cmxUb01hdGNoLmhhc2ggPSAnJztcblxuICBpZiAoaWdub3JlU2VhcmNoKSB7XG4gICAgdXJsVG9NYXRjaC5zZWFyY2ggPSAnJztcbiAgICBpbmRleE5hbWUgKz0gJ05vU2VhcmNoJztcbiAgfVxuXG4gIC8vIHdvcmtpbmcgYXJvdW5kIGNocm9tZSBidWdzXG4gIHVybFRvTWF0Y2ggPSB1cmxUb01hdGNoLmhyZWYucmVwbGFjZSgvKFxcP3wjfFxcPyMpJC8sICcnKTtcblxuICBpbmRleCA9IGNhY2hlRW50cmllcy5pbmRleChpbmRleE5hbWUpO1xuXG4gIGlmIChwcmVmaXhNYXRjaCkge1xuICAgIHJhbmdlID0gSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCB1cmxUb01hdGNoICsgU3RyaW5nLmZyb21DaGFyQ29kZSg2NTUzNSksIEluZmluaXR5XSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmFuZ2UgPSBJREJLZXlSYW5nZS5ib3VuZChbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIDBdLCBbb3JpZ2luLCBjYWNoZU5hbWUsIHVybFRvTWF0Y2gsIEluZmluaXR5XSk7XG4gIH1cblxuICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKHJhbmdlKSwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgdmFyIHZhbHVlID0gY3Vyc29yLnZhbHVlO1xuXG4gICAgaWYgKGlnbm9yZVZhcnkgfHwgbWF0Y2hlc1ZhcnkocmVxdWVzdCwgY3Vyc29yLnZhbHVlLnJlcXVlc3QsIGN1cnNvci52YWx1ZS5yZXNwb25zZSkpIHtcbiAgICAgIC8vIGl0J3MgZG93biB0byB0aGUgY2FsbGJhY2sgdG8gY2FsbCBjdXJzb3IuY29udGludWUoKVxuICAgICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG4gICAgfVxuICB9LCBkb25lQ2FsbGJhY2ssIGVycm9yQ2FsbGJhY2spO1xufTtcblxuQ2FjaGVEQlByb3RvLl9oYXNDYWNoZSA9IGZ1bmN0aW9uKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgZG9uZUNhbGxiYWNrLCBlcnJDYWxsYmFjaykge1xuICB2YXIgc3RvcmUgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVOYW1lcycpO1xuICByZXR1cm4gSURCSGVscGVyLmNhbGxiYWNraWZ5KHN0b3JlLmdldChbb3JpZ2luLCBjYWNoZU5hbWVdKSwgZnVuY3Rpb24odmFsKSB7XG4gICAgZG9uZUNhbGxiYWNrKCEhdmFsKTtcbiAgfSwgZXJyQ2FsbGJhY2spO1xufTtcblxuQ2FjaGVEQlByb3RvLl9kZWxldGUgPSBmdW5jdGlvbih0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGRvbmVDYWxsYmFjaywgZXJyQ2FsbGJhY2ssIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsID0gZmFsc2U7XG5cbiAgdGhpcy5fZWFjaE1hdGNoKHR4LCBvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgZnVuY3Rpb24oY3Vyc29yKSB7XG4gICAgcmV0dXJuVmFsID0gdHJ1ZTtcbiAgICBjdXJzb3IuZGVsZXRlKCk7XG4gICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gIH0sIGZ1bmN0aW9uKCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhyZXR1cm5WYWwpO1xuICAgIH1cbiAgfSwgZXJyQ2FsbGJhY2ssIHBhcmFtcyk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBbGxSZXF1ZXN0cyA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3Iua2V5KTtcbiAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoZXMubWFwKGVudHJ5VG9SZXF1ZXN0KTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uYWxsUmVxdWVzdHMgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHZhciBjYWNoZUVudHJpZXMgPSB0eC5vYmplY3RTdG9yZSgnY2FjaGVFbnRyaWVzJyk7XG4gICAgdmFyIGluZGV4ID0gY2FjaGVFbnRyaWVzLmluZGV4KCdvcmlnaW4tY2FjaGVOYW1lJyk7XG5cbiAgICBJREJIZWxwZXIuaXRlcmF0ZShpbmRleC5vcGVuQ3Vyc29yKElEQktleVJhbmdlLmJvdW5kKFtvcmlnaW4sIGNhY2hlTmFtZSwgMF0sIFtvcmlnaW4sIGNhY2hlTmFtZSwgSW5maW5pdHldKSksIGZ1bmN0aW9uKGN1cnNvcikge1xuICAgICAgbWF0Y2hlcy5wdXNoKGN1cnNvci52YWx1ZSk7XG4gICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICB9KTtcbiAgfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1JlcXVlc3QpO1xuICB9KTtcbn07XG5cbkNhY2hlREJQcm90by5tYXRjaEFsbCA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBwYXJhbXMpIHtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoZXMucHVzaChjdXJzb3IudmFsdWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfSwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gIH0uYmluZCh0aGlzKSkudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gbWF0Y2hlcy5tYXAoZW50cnlUb1Jlc3BvbnNlKTtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2ggPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSwgcmVxdWVzdCwgcGFyYW1zKSB7XG4gIHZhciBtYXRjaDtcblxuICByZXF1ZXN0ID0gY2FzdFRvUmVxdWVzdChyZXF1ZXN0KTtcblxuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVFbnRyaWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9lYWNoTWF0Y2godHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG1hdGNoID0gY3Vyc29yLnZhbHVlO1xuICAgIH0sIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBwYXJhbXMpO1xuICB9LmJpbmQodGhpcykpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIG1hdGNoID8gZW50cnlUb1Jlc3BvbnNlKG1hdGNoKSA6IHVuZGVmaW5lZDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ubWF0Y2hBY3Jvc3NDYWNoZXMgPSBmdW5jdGlvbihvcmlnaW4sIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgbWF0Y2g7XG5cbiAgcmVxdWVzdCA9IGNhc3RUb1JlcXVlc3QocmVxdWVzdCk7XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihuYW1lc0N1cnNvcikge1xuICAgICAgdmFyIGNhY2hlTmFtZSA9IG5hbWVzQ3Vyc29yLnZhbHVlLm5hbWU7XG5cbiAgICAgIHRoaXMuX2VhY2hNYXRjaCh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIGZ1bmN0aW9uIGVhY2gocmVzcG9uc2VDdXJzb3IpIHtcbiAgICAgICAgbWF0Y2ggPSByZXNwb25zZUN1cnNvci52YWx1ZTtcbiAgICAgIH0sIGZ1bmN0aW9uIGRvbmUoKSB7XG4gICAgICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgICBuYW1lc0N1cnNvci5jb250aW51ZSgpO1xuICAgICAgICB9XG4gICAgICB9LCB1bmRlZmluZWQsIHBhcmFtcyk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBtYXRjaCA/IGVudHJ5VG9SZXNwb25zZShtYXRjaCkgOiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmNhY2hlTmFtZXMgPSBmdW5jdGlvbihvcmlnaW4pIHtcbiAgdmFyIG5hbWVzID0gW107XG5cbiAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oJ2NhY2hlTmFtZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2VhY2hDYWNoZSh0eCwgb3JpZ2luLCBmdW5jdGlvbihjdXJzb3IpIHtcbiAgICAgIG5hbWVzLnB1c2goY3Vyc29yLnZhbHVlLm5hbWUpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBuYW1lcztcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uZGVsZXRlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcykge1xuICB2YXIgcmV0dXJuVmFsO1xuXG4gIHJlcXVlc3QgPSBjYXN0VG9SZXF1ZXN0KHJlcXVlc3QpO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZUVudHJpZXMnLCBmdW5jdGlvbih0eCkge1xuICAgIHRoaXMuX2RlbGV0ZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIHJlcXVlc3QsIHBhcmFtcywgZnVuY3Rpb24odikge1xuICAgICAgcmV0dXJuVmFsID0gdjtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLm9wZW5DYWNoZSA9IGZ1bmN0aW9uKG9yaWdpbiwgY2FjaGVOYW1lKSB7XG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKCdjYWNoZU5hbWVzJywgZnVuY3Rpb24odHgpIHtcbiAgICB0aGlzLl9oYXNDYWNoZSh0eCwgb3JpZ2luLCBjYWNoZU5hbWUsIGZ1bmN0aW9uKHZhbCkge1xuICAgICAgaWYgKHZhbCkgeyByZXR1cm47IH1cbiAgICAgIHZhciBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJyk7XG4gICAgICBzdG9yZS5hZGQoe1xuICAgICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgICAgbmFtZTogY2FjaGVOYW1lLFxuICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgICAgfSk7XG4gICAgfSk7XG4gIH0uYmluZCh0aGlzKSwge21vZGU6ICdyZWFkd3JpdGUnfSk7XG59O1xuXG5DYWNoZURCUHJvdG8uaGFzQ2FjaGUgPSBmdW5jdGlvbihvcmlnaW4sIGNhY2hlTmFtZSkge1xuICB2YXIgcmV0dXJuVmFsO1xuICByZXR1cm4gdGhpcy5kYi50cmFuc2FjdGlvbignY2FjaGVOYW1lcycsIGZ1bmN0aW9uKHR4KSB7XG4gICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbih2YWwpIHtcbiAgICAgIHJldHVyblZhbCA9IHZhbDtcbiAgICB9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKHZhbCkge1xuICAgIHJldHVybiByZXR1cm5WYWw7XG4gIH0pO1xufTtcblxuQ2FjaGVEQlByb3RvLmRlbGV0ZUNhY2hlID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUpIHtcbiAgdmFyIHJldHVyblZhbCA9IGZhbHNlO1xuXG4gIHJldHVybiB0aGlzLmRiLnRyYW5zYWN0aW9uKFsnY2FjaGVFbnRyaWVzJywgJ2NhY2hlTmFtZXMnXSwgZnVuY3Rpb24odHgpIHtcbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZU5hbWVzJykub3BlbkN1cnNvcihJREJLZXlSYW5nZS5vbmx5KFtvcmlnaW4sIGNhY2hlTmFtZV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBJREJIZWxwZXIuaXRlcmF0ZShcbiAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5pbmRleCgnb3JpZ2luLWNhY2hlTmFtZScpLm9wZW5DdXJzb3IoSURCS2V5UmFuZ2UuYm91bmQoW29yaWdpbiwgY2FjaGVOYW1lLCAwXSwgW29yaWdpbiwgY2FjaGVOYW1lLCBJbmZpbml0eV0pKSxcbiAgICAgIGRlbFxuICAgICk7XG5cbiAgICBmdW5jdGlvbiBkZWwoY3Vyc29yKSB7XG4gICAgICByZXR1cm5WYWwgPSB0cnVlO1xuICAgICAgY3Vyc29yLmRlbGV0ZSgpO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgfVxuICB9LmJpbmQodGhpcyksIHttb2RlOiAncmVhZHdyaXRlJ30pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHJldHVyblZhbDtcbiAgfSk7XG59O1xuXG5DYWNoZURCUHJvdG8ucHV0ID0gZnVuY3Rpb24ob3JpZ2luLCBjYWNoZU5hbWUsIGl0ZW1zKSB7XG4gIC8vIGl0ZW1zIGlzIFtbcmVxdWVzdCwgcmVzcG9uc2VdLCBbcmVxdWVzdCwgcmVzcG9uc2VdLCDigKZdXG4gIHZhciBpdGVtO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaXRlbXMubGVuZ3RoOyBpKyspIHtcbiAgICBpdGVtc1tpXVswXSA9IGNhc3RUb1JlcXVlc3QoaXRlbXNbaV1bMF0pO1xuXG4gICAgaWYgKGl0ZW1zW2ldWzBdLm1ldGhvZCAhPSAnR0VUJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcignT25seSBHRVQgcmVxdWVzdHMgYXJlIHN1cHBvcnRlZCcpKTtcbiAgICB9XG5cbiAgICBpZiAoaXRlbXNbaV1bMV0udHlwZSA9PSAnb3BhcXVlJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFR5cGVFcnJvcihcIlRoZSBwb2x5ZmlsbCBkb2Vzbid0IHN1cHBvcnQgb3BhcXVlIHJlc3BvbnNlcyAoZnJvbSBjcm9zcy1vcmlnaW4gbm8tY29ycyByZXF1ZXN0cylcIikpO1xuICAgIH1cblxuICAgIC8vIGVuc3VyZSBlYWNoIGVudHJ5IGJlaW5nIHB1dCB3b24ndCBvdmVyd3JpdGUgZWFybGllciBlbnRyaWVzIGJlaW5nIHB1dFxuICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XG4gICAgICBpZiAoaXRlbXNbaV1bMF0udXJsID09IGl0ZW1zW2pdWzBdLnVybCAmJiBtYXRjaGVzVmFyeShpdGVtc1tqXVswXSwgaXRlbXNbaV1bMF0sIGl0ZW1zW2ldWzFdKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoVHlwZUVycm9yKCdQdXRzIHdvdWxkIG92ZXJ3cml0ZSBlYWNob3RoZXInKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIGl0ZW1zLm1hcChmdW5jdGlvbihpdGVtKSB7XG4gICAgICByZXR1cm4gaXRlbVsxXS50ZXh0KCk7XG4gICAgfSlcbiAgKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlQm9kaWVzKSB7XG4gICAgcmV0dXJuIHRoaXMuZGIudHJhbnNhY3Rpb24oWydjYWNoZUVudHJpZXMnLCAnY2FjaGVOYW1lcyddLCBmdW5jdGlvbih0eCkge1xuICAgICAgdGhpcy5faGFzQ2FjaGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCBmdW5jdGlvbihoYXNDYWNoZSkge1xuICAgICAgICBpZiAoIWhhc0NhY2hlKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoXCJDYWNoZSBvZiB0aGF0IG5hbWUgZG9lcyBub3QgZXhpc3RcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpdGVtcy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0sIGkpIHtcbiAgICAgICAgICB2YXIgcmVxdWVzdCA9IGl0ZW1bMF07XG4gICAgICAgICAgdmFyIHJlc3BvbnNlID0gaXRlbVsxXTtcbiAgICAgICAgICB2YXIgcmVxdWVzdEVudHJ5ID0gcmVxdWVzdFRvRW50cnkocmVxdWVzdCk7XG4gICAgICAgICAgdmFyIHJlc3BvbnNlRW50cnkgPSByZXNwb25zZVRvRW50cnkocmVzcG9uc2UsIHJlc3BvbnNlQm9kaWVzW2ldKTtcblxuICAgICAgICAgIHZhciByZXF1ZXN0VXJsTm9TZWFyY2ggPSBuZXcgVVJMKHJlcXVlc3QudXJsKTtcbiAgICAgICAgICByZXF1ZXN0VXJsTm9TZWFyY2guc2VhcmNoID0gJyc7XG4gICAgICAgICAgLy8gd29ya2luZyBhcm91bmQgQ2hyb21lIGJ1Z1xuICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaCA9IHJlcXVlc3RVcmxOb1NlYXJjaC5ocmVmLnJlcGxhY2UoL1xcPyQvLCAnJyk7XG5cbiAgICAgICAgICB0aGlzLl9kZWxldGUodHgsIG9yaWdpbiwgY2FjaGVOYW1lLCByZXF1ZXN0LCBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHR4Lm9iamVjdFN0b3JlKCdjYWNoZUVudHJpZXMnKS5hZGQoe1xuICAgICAgICAgICAgICBvcmlnaW46IG9yaWdpbixcbiAgICAgICAgICAgICAgY2FjaGVOYW1lOiBjYWNoZU5hbWUsXG4gICAgICAgICAgICAgIHJlcXVlc3Q6IHJlcXVlc3RFbnRyeSxcbiAgICAgICAgICAgICAgcmVzcG9uc2U6IHJlc3BvbnNlRW50cnksXG4gICAgICAgICAgICAgIHJlcXVlc3RVcmxOb1NlYXJjaDogcmVxdWVzdFVybE5vU2VhcmNoLFxuICAgICAgICAgICAgICB2YXJ5SUQ6IGNyZWF0ZVZhcnlJRChyZXF1ZXN0RW50cnksIHJlc3BvbnNlRW50cnkpLFxuICAgICAgICAgICAgICBhZGRlZDogRGF0ZS5ub3coKVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgfS5iaW5kKHRoaXMpKTtcbiAgICAgIH0uYmluZCh0aGlzKSk7XG4gICAgfS5iaW5kKHRoaXMpLCB7bW9kZTogJ3JlYWR3cml0ZSd9KTtcbiAgfS5iaW5kKHRoaXMpKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH0pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgQ2FjaGVEQigpOyIsInZhciBjYWNoZURCID0gcmVxdWlyZSgnLi9jYWNoZWRiJyk7XG52YXIgQ2FjaGUgPSByZXF1aXJlKCcuL2NhY2hlJyk7XG5cbmZ1bmN0aW9uIENhY2hlU3RvcmFnZSgpIHtcbiAgdGhpcy5fb3JpZ2luID0gbG9jYXRpb24ub3JpZ2luO1xufVxuXG52YXIgQ2FjaGVTdG9yYWdlUHJvdG8gPSBDYWNoZVN0b3JhZ2UucHJvdG90eXBlO1xuXG5DYWNoZVN0b3JhZ2VQcm90by5fdmVuZENhY2hlID0gZnVuY3Rpb24obmFtZSkge1xuICB2YXIgY2FjaGUgPSBuZXcgQ2FjaGUoKTtcbiAgY2FjaGUuX25hbWUgPSBuYW1lO1xuICBjYWNoZS5fb3JpZ2luID0gdGhpcy5fb3JpZ2luO1xuICByZXR1cm4gY2FjaGU7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QsIHBhcmFtcykge1xuICByZXR1cm4gY2FjaGVEQi5tYXRjaEFjcm9zc0NhY2hlcyh0aGlzLl9vcmlnaW4sIHJlcXVlc3QsIHBhcmFtcyk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5oYXMgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmhhc0NhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5vcGVuID0gZnVuY3Rpb24obmFtZSkge1xuICByZXR1cm4gY2FjaGVEQi5vcGVuQ2FjaGUodGhpcy5fb3JpZ2luLCBuYW1lKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiB0aGlzLl92ZW5kQ2FjaGUobmFtZSk7XG4gIH0uYmluZCh0aGlzKSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5kZWxldGUgPSBmdW5jdGlvbihuYW1lKSB7XG4gIHJldHVybiBjYWNoZURCLmRlbGV0ZUNhY2hlKHRoaXMuX29yaWdpbiwgbmFtZSk7XG59O1xuXG5DYWNoZVN0b3JhZ2VQcm90by5rZXlzID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBjYWNoZURCLmNhY2hlTmFtZXModGhpcy5fb3JpZ2luKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IENhY2hlU3RvcmFnZSgpO1xuIiwiZnVuY3Rpb24gSURCSGVscGVyKG5hbWUsIHZlcnNpb24sIHVwZ3JhZGVDYWxsYmFjaykge1xuICB2YXIgcmVxdWVzdCA9IChzZWxmLl9pbmRleGVkREIgfHwgc2VsZi5pbmRleGVkREIpLm9wZW4obmFtZSwgdmVyc2lvbik7XG4gIHRoaXMucmVhZHkgPSBJREJIZWxwZXIucHJvbWlzaWZ5KHJlcXVlc3QpO1xuICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKGV2ZW50KSB7XG4gICAgdXBncmFkZUNhbGxiYWNrKHJlcXVlc3QucmVzdWx0LCBldmVudC5vbGRWZXJzaW9uKTtcbiAgfTtcbn1cblxuSURCSGVscGVyLnN1cHBvcnRlZCA9ICdfaW5kZXhlZERCJyBpbiBzZWxmIHx8ICdpbmRleGVkREInIGluIHNlbGY7XG5cbklEQkhlbHBlci5wcm9taXNpZnkgPSBmdW5jdGlvbihvYmopIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIElEQkhlbHBlci5jYWxsYmFja2lmeShvYmosIHJlc29sdmUsIHJlamVjdCk7XG4gIH0pO1xufTtcblxuSURCSGVscGVyLmNhbGxiYWNraWZ5ID0gZnVuY3Rpb24ob2JqLCBkb25lQ2FsbGJhY2ssIGVyckNhbGxiYWNrKSB7XG4gIGZ1bmN0aW9uIG9uc3VjY2VzcyhldmVudCkge1xuICAgIGlmIChkb25lQ2FsbGJhY2spIHtcbiAgICAgIGRvbmVDYWxsYmFjayhvYmoucmVzdWx0KTtcbiAgICB9XG4gIH1cbiAgZnVuY3Rpb24gb25lcnJvcihldmVudCkge1xuICAgIGlmIChlcnJDYWxsYmFjaykge1xuICAgICAgZXJyQ2FsbGJhY2sob2JqLmVycm9yKTtcbiAgICB9XG4gIH1cbiAgb2JqLm9uY29tcGxldGUgPSBvbnN1Y2Nlc3M7XG4gIG9iai5vbnN1Y2Nlc3MgPSBvbnN1Y2Nlc3M7XG4gIG9iai5vbmVycm9yID0gb25lcnJvcjtcbiAgb2JqLm9uYWJvcnQgPSBvbmVycm9yO1xufTtcblxuSURCSGVscGVyLml0ZXJhdGUgPSBmdW5jdGlvbihjdXJzb3JSZXF1ZXN0LCBlYWNoQ2FsbGJhY2ssIGRvbmVDYWxsYmFjaywgZXJyb3JDYWxsYmFjaykge1xuICB2YXIgb2xkQ3Vyc29yQ29udGludWU7XG5cbiAgZnVuY3Rpb24gY3Vyc29yQ29udGludWUoKSB7XG4gICAgdGhpcy5fY29udGludWluZyA9IHRydWU7XG4gICAgcmV0dXJuIG9sZEN1cnNvckNvbnRpbnVlLmNhbGwodGhpcyk7XG4gIH1cblxuICBjdXJzb3JSZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBjdXJzb3IgPSBjdXJzb3JSZXF1ZXN0LnJlc3VsdDtcblxuICAgIGlmICghY3Vyc29yKSB7XG4gICAgICBpZiAoZG9uZUNhbGxiYWNrKSB7XG4gICAgICAgIGRvbmVDYWxsYmFjaygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChjdXJzb3IuY29udGludWUgIT0gY3Vyc29yQ29udGludWUpIHtcbiAgICAgIG9sZEN1cnNvckNvbnRpbnVlID0gY3Vyc29yLmNvbnRpbnVlO1xuICAgICAgY3Vyc29yLmNvbnRpbnVlID0gY3Vyc29yQ29udGludWU7XG4gICAgfVxuXG4gICAgZWFjaENhbGxiYWNrKGN1cnNvcik7XG5cbiAgICBpZiAoIWN1cnNvci5fY29udGludWluZykge1xuICAgICAgaWYgKGRvbmVDYWxsYmFjaykge1xuICAgICAgICBkb25lQ2FsbGJhY2soKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgY3Vyc29yUmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVycm9yQ2FsbGJhY2spIHtcbiAgICAgIGVycm9yQ2FsbGJhY2soY3Vyc29yUmVxdWVzdC5lcnJvcik7XG4gICAgfVxuICB9O1xufTtcblxudmFyIElEQkhlbHBlclByb3RvID0gSURCSGVscGVyLnByb3RvdHlwZTtcblxuSURCSGVscGVyUHJvdG8udHJhbnNhY3Rpb24gPSBmdW5jdGlvbihzdG9yZXMsIGNhbGxiYWNrLCBvcHRzKSB7XG4gIG9wdHMgPSBvcHRzIHx8IHt9O1xuXG4gIHJldHVybiB0aGlzLnJlYWR5LnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICB2YXIgbW9kZSA9IG9wdHMubW9kZSB8fCAncmVhZG9ubHknO1xuXG4gICAgdmFyIHR4ID0gZGIudHJhbnNhY3Rpb24oc3RvcmVzLCBtb2RlKTtcbiAgICBjYWxsYmFjayh0eCwgZGIpO1xuICAgIHJldHVybiBJREJIZWxwZXIucHJvbWlzaWZ5KHR4KTtcbiAgfSk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IElEQkhlbHBlcjsiXX0=
