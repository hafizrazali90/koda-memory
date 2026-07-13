module.exports = {
  apps: [{
    name: 'koda-memory',
    script: 'dist/index.js',
    cwd: '/opt/koda/app',
    env: {
      PORT: 3848,
      KODA_DB_PATH: '/opt/koda/brain.db',
      KODA_API_KEY: process.env.KODA_API_KEY,
      KODA_ADMIN_USERS: 'hafiz',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NODE_ENV: 'production',
    },
    max_memory_restart: '256M',
    error_file: '/opt/koda/logs/error.log',
    out_file: '/opt/koda/logs/out.log',
    time: true,
  }],
};
