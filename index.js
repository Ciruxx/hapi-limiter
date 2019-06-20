const Hoek = require('@hapi/hoek');
const Boom = require('@hapi/boom');
const hapiLimiter = 'hapi-limiter';

const internals = {
  defaults: {
    cache: {
      expiresIn: 1000 * 60 * 15,
      segment: hapiLimiter
    },
    limit: 15,
    ttl: 1000 * 60 * 15,
    generateKeyFunc: function (request) {
      const methodAndPath = request.method + ':' + request.path + ':';
      let ip = request.headers['x-forwarded-for'];

      if (!ip) {
        ip = request.info.remoteAddress;
      }

      return methodAndPath + ip;
    }
  }
};


async function register(server, options) {
  const globalSettings = Hoek.applyToDefaults(internals.defaults, options);

  let cacheClient = globalSettings.cacheClient;

  if ( !cacheClient ) {
    cacheClient = server.cache(globalSettings.cache);
  }

  server.ext('onPreHandler', function (request, h) {
    const routePlugins = request.route.settings.plugins;

    if (
      !routePlugins[hapiLimiter] ||
      !routePlugins[hapiLimiter].enable
    ) {
      return h.continue();
    }

    const pluginSettings = Hoek.applyToDefaults(globalSettings, routePlugins[hapiLimiter]);

    const keyValue = pluginSettings.generateKeyFunc(request);

    cacheClient.get(keyValue, function(err, value, cached) {
      if ( err ) {
        return err;
      }
      request.plugins[hapiLimiter] = {};
      request.plugins[hapiLimiter].limit = pluginSettings.limit;

      if ( !cached ) {
        const reset = Date.now() + pluginSettings.ttl;
        return cacheClient.set(keyValue, { remaining: pluginSettings.limit - 1 }, pluginSettings.ttl, function(err) {
          if ( err ) {
            return err;
          }
          request.plugins[hapiLimiter].remaining = pluginSettings.limit - 1;
          request.plugins[hapiLimiter].reset = reset;
          h.continue();
        });
      }

      request.plugins[hapiLimiter].remaining = value.remaining - 1;
      request.plugins[hapiLimiter].reset = Date.now() + cached.ttl;

      let error;
      if (  request.plugins[hapiLimiter].remaining < 0 ) {
        error = Boom.tooManyRequests('Rate Limit Exceeded');
        error.output.headers['X-Rate-Limit-Limit'] = request.plugins[hapiLimiter].limit;
        error.output.headers['X-Rate-Limit-Reset'] = request.plugins[hapiLimiter].reset;
        error.output.headers['X-Rate-Limit-Remaining'] = 0;
        error.reformat();
        return error;
      }

      cacheClient.set(
        keyValue,
        { remaining: request.plugins[hapiLimiter].remaining },
        cached.ttl, function(err) {
        if ( err ) {
          return err;
        }

            h.continue();
      });
    });
  });

  server.ext('onPostHandler', function (request, h) {
    const pluginSettings = request.route.settings.plugins;
    let response;

    if (
      pluginSettings[hapiLimiter] &&
      pluginSettings[hapiLimiter].enable
    ) {
      response = request.response;

      let headers = response.headers;
      if(!response.headers) {
          if (response.isBoom) {
              headers = response.output.headers
          }
      }

      headers['X-Rate-Limit-Limit'] = request.plugins[hapiLimiter].limit;
      headers['X-Rate-Limit-Remaining'] = request.plugins[hapiLimiter].remaining;
      headers['X-Rate-Limit-Reset'] = request.plugins[hapiLimiter].reset;
    }

    h.continue();
  });
}

exports.plugin = {
  name: "hapi-limiter",
  version: "1.0.0",
  pkg: require('./package.json'),
  register: register
};
