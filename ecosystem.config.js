module.exports = {
  apps: [{
    name: 'order-monitor',
    script: './backend/monitor-pending.js',
    cwd: '/Users/donaldnemec/kraken-trader',
    env: {
      BINANCE_API_KEY: 'oC4o63DvvDkMVpHP5GLU533LuZ00dV0Ofz004xjbJ8y3ZabkW2L2Gw47sYPKB6XX',
      BINANCE_API_SECRET: 'ptAMhj3zkGRzYx4aq62A0drX6cn3VSbNSORrUbGz616n0jxxS61dEsWMtgb6BZ8t',
      BINANCE_BASE_URL: 'https://api.binance.us',
      KRAKEN_API_KEY: 'l7l4XGYh1dce/Djffwgo/JLpDxHiMI+UW/h6xdIS7jQpz9YO1X1SVSoF',
      KRAKEN_API_SECRET: 'xRq8HCcTFECaWLx9NSdW4GO5lA9JLCkLjX9jVX2CzIw60giDbB8SJzhHHFBBcODg/a0fj52MJlkEB1fKVmi8qw==',
      KRAKEN_BASE_URL: 'https://api.kraken.com',
      PORT: '3003',
      NODE_ENV: 'production'
    },
    error_file: './logs/monitor-error.log',
    out_file: './logs/monitor-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M'
  }]
};
