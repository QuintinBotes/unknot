const fastify = require('fastify')();

fastify.route({ method: 'GET', url: '/ping', handler: async () => 'pong' });
fastify.route({ method: ['PUT', 'POST'], url: '/things', handler });

fastify.get('/status', async () => ({ ok: true }));
cache.get('/not-a-route');
