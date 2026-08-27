// Thin LAN transport boundary. Socket lifecycle and persistence are isolated
// from controllers in infrastructure/sync-lan-listener.
const core = require('./cloud-sync-core');
const {
  DEFAULT_PORT,
  PORT_FALLBACK_COUNT,
  createLanListener,
} = require('../../infrastructure/sync-lan-listener');

module.exports = {
  DEFAULT_PORT,
  PORT_FALLBACK_COUNT,
  ...createLanListener({ core }),
};
