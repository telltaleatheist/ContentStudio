// pm2 definition for Triton. Deployed next to dist/ by deploy.sh.
module.exports = {
  apps: [
    {
      name: 'contentstudio-scheduler',
      script: 'dist/src/index.js',
      cwd: '/home/owenmorgan/apps/visibility-scheduler',
      env: { SCHEDULER_DATA_DIR: '/home/owenmorgan/apps/visibility-scheduler-data', NODE_ENV: 'production' },
      node_args: '--no-warnings=ExperimentalWarning',
      time: true,
      kill_timeout: 30000, // a change in flight finishes before the process stops
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
