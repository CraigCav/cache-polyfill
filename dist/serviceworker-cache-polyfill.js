(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
if(!window.caches) window.caches = require('../lib/caches.js');
},{"../lib/caches.js":4}],2:[function(require,module,exports){
var cacheDB = require('./cachedb');

function Cache() {
  this._name = '';
  this._origin = '';
}

var CacheProto = Cache.prototype;

CacheProto.put = function(request, response) {
  if (!(response instanceof Response)) {
    throw TypeError("Incorrect response type");
  }

  return cacheDB.put(this._origin, this._name, [[request, response]]);
};

module.exports = Cache;

},{"./cachedb":3}],3:[function(require,module,exports){
function flattenHeaders(headers) {
  var returnVal = {};

  headers.forEach(function (value, name) {
    returnVal[name.toLowerCase()] = value;
  });

  return returnVal;
}

function entryToResponse(entryResponse) {
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

function castToRequest(request) {
  if (!(request instanceof Request)) {
    request = new Request(request);
  }
  return request;
}

function CacheDB() {}

var CacheDBProto = CacheDB.prototype;

CacheDBProto.matchAcrossCaches = function(origin, request, params) {
  request = castToRequest(request);

  var entryString = localStorage.getItem(request.url);

  if(entryString === null) return Promise.resolve();

  var match = JSON.parse(entryString);

  return Promise.resolve(entryToResponse(match));
};

CacheDBProto.openCache = function(origin, cacheName) {
  var namesString = localStorage.getItem('cache-polyfill-cacheNames');

  var cacheNames = JSON.parse(namesString) || {};

  if(cacheName in cacheNames) return;

  cacheNames[cacheName] = {};

  localStorage.setItem('cache-polyfill-cacheNames', JSON.stringify(cacheNames));
};

CacheDBProto.deleteCache = function(origin, cacheName) {
  var namesString = localStorage.getItem('cache-polyfill-cacheNames');

  if(namesString === null) return Promise.resolve(false);

  var cacheNames = JSON.parse(namesString);

  if(!(cacheName in cacheNames)) return Promise.resolve(false);

  for(var url in cacheNames[cacheName]) {
    localStorage.removeItem(url);
  }

  delete cacheNames[cacheName];
  localStorage.setItem('cache-polyfill-cacheNames', JSON.stringify(cacheNames));

  return Promise.resolve(true);
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
  }

  return Promise.all(
    items.map(function(item) {
      return item[1].text();
    })
  ).then(function(responseBodies) {

    var namesString = localStorage.getItem('cache-polyfill-cacheNames');

    if(namesString === null) return Promise.resolve(false);

    var cacheNames = JSON.parse(namesString);

    if(!(cacheName in cacheNames)) throw Error("Cache of that name does not exist");

    items.forEach(function(item, i) {
      var request = item[0];
      var response = item[1];
      var responseEntry = responseToEntry(response, responseBodies[i]);

      cacheNames[cacheName][request.url] = 1;

      localStorage.setItem(request.url, JSON.stringify(responseEntry));
    });

    localStorage.setItem('cache-polyfill-cacheNames', JSON.stringify(cacheNames));
  })
  .then(function() {
    return undefined;
  });
};

module.exports = new CacheDB();
},{}],4:[function(require,module,exports){
var cacheDB = require('./cachedb');
var Cache = require('./cache');

function CacheStorage() {
  this._origin = location.origin;
}

var CacheStorageProto = CacheStorage.prototype;

CacheStorageProto.match = function(request, params) {
  return cacheDB.matchAcrossCaches(this._origin, request, params);
};

CacheStorageProto.open = function(name) {
  cacheDB.openCache(this._origin, name);

  var cache = new Cache();
  cache._name = name;
  cache._origin = this._origin;
  return Promise.resolve(cache);
};

CacheStorageProto.delete = function(name) {
  return cacheDB.deleteCache(this._origin, name);
};

module.exports = new CacheStorage();

},{"./cache":2,"./cachedb":3}]},{},[1])
