// Import first in any test that runs git. Tests and the code under test then read no
// global or system git configuration (hooks, signing, templates), so results and speed
// match CI. A test about repository hooks sets the configuration it needs explicitly.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
