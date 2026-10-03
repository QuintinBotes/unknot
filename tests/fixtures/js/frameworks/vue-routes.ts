import { createRouter } from 'vue-router';

const routes = [
  { path: '/', component: Home },
  { path: '/about', component: () => import('./About.vue') },
];

export default createRouter({ routes });
