// HTTP route registration keeps its historical module boundary. Provider
// lifecycle work is implemented in the application layer so callers retain
// every exported handler without coupling route setup to domain internals.
module.exports = require('../../application/provider-service');
