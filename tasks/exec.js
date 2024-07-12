'use strict';

// Modules
const path = require('path');
const _ = require('lodash');

const {color} = require('listr2');

module.exports = (lando, config) => ({
  command: 'exec',
  describe: 'Runs commands on a service',
  usage: '$0 exec <service> [--user <user>] -- <command>',
  override: true,
  level: 'engine',
  positionals: {
    service: {
      describe: 'Runs on this service',
      type: 'string',
      choices: Object.keys(config?.services ?? {}),
    },
  },
  options: {
    user: {
      describe: 'Runs as a specific user',
      alias: ['u'],
    },
  },
  run: async options => {
    // Build a minimal app
    const AsyncEvents = require('../lib/events');
    const app = lando.cache.get(path.basename(config.composeCache));

    // if no app then we need to throw
    if (!app) throw new Error('Could not detect a built app. Rebuild or move into the correct location!');

    // augment
    app.config = config;
    app.events = new AsyncEvents(lando.log);

    // Load only what we need so we don't pay the appinit penalty
    if (!_.isEmpty(_.get(app, 'config.events', []))) {
      _.forEach(app.config.events, (cmds, name) => {
        app.events.on(name, 9999, async data => await require('../hooks/app-run-events')(app, lando, cmds, data));
      });
    }

    // nice things
    const aservices = Object.keys(config?.services ?? {});
    const choices = `[${color.green('choices:')} ${aservices.map(service => `"${service}"`).join(', ')}]`;

    // gather our options
    options.service = options._[1];
    options.command = options['--'];

    // and validate
    try {
      // no service
      if (!options.service) {
        throw new Error('You must specific a service! See usage above.');
      }

      // not a valid service
      if (!aservices.includes(options.service)) {
        throw new Error(`Service must be one of ${choices}! See usage above.`);
      }

      // empty or nonexistent command
      if (!options.command || options.command.length === 0) {
        throw new Error('You must specify a command! See usage above.');
      }

    // collect, usage throw
    } catch (error) {
      if (options?._yargs?.showHelp) options._yargs.showHelp();
      console.log('');
      throw error;
    }

    // if command is a single thing then lets string argv that
    // this is useful to handle wrapping more complex commands a la "cmd && cmd"
    if (Array.isArray(options.command) && options.command.length === 1) {
      options.command = require('string-argv')(options.command[0]);
    }

    // if this service has /etc/lando/exec then prepend
    if (app?.executors?.[options.service]) options.command.unshift('/etc/lando/exec.sh');

    // spoof options we can pass into build tooling runner
    const ropts = [
      app,
      options.command,
      options.service,
      options.user ?? null,
      {
        DEBUG: lando.debuggy ? '1' : '',
        LANDO_DEBUG: lando.debuggy ? '1' : '',
      },
    ];

    // ensure all v3 services have their appMount set to /app
    // @TODO: do we still need this?
    const v3Mounts = _(_.get(app, 'info', []))
      .filter(service => service.api !== 4)
      .map(service => ([service.service, service.appMount || '/app']))
      .fromPairs()
      .value();
    app.mounts = _.merge({}, v3Mounts, app.mounts);

    // and working dir data if no dir or appMount
    ropts.push(app?.config?.services?.[options.service]?.working_dir);
    // mix in mount if applicable
    ropts.push(app?.mounts[options.service]);

    // emit pre-exec
    await app.events.emit('pre-exec', config);

    // get tooling runner
    const runner = require('../utils/build-tooling-runner')(...ropts);

    // try to run it
    try {
      await require('../utils/build-docker-exec')(lando, ['inherit', 'pipe', 'pipe'], runner);

    // error
    } catch (error) {
      return lando.engine.isRunning(runner.id).then(isRunning => {
        if (!isRunning) {
          throw new Error(`Looks like your app is stopped! ${color.bold('lando start')} it up to exec your heart out.`);
        } else {
          error.hide = true;
          throw error;
        }
      });

    // finally
    } finally {
      await app.events.emit('post-exec', config);
    }
  },
});
