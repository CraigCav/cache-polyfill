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
