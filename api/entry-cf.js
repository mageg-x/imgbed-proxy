import { handleRequest } from './index.js';

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});
