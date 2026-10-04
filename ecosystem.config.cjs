module.exports = {
  apps: [{
    name: 'cooperative-poker',
    script: 'src/server.js',
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 3000 },
    time: true,
    max_memory_restart: '300M'
  }]
};
