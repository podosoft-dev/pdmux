/**
 * @pdmux/core — framework-free logic for a host/terminal dashboard.
 *
 * WHY IT IS ITS OWN PACKAGE: every rule here (which cells are visible, when a value
 * is red, which lane a commit gets) has to behave identically in the web app, in a
 * server-side render and in a unit test. Keeping it away from any framework is what
 * makes that possible — nothing in this package touches the DOM, the network or a
 * global, and every function is pure and total: junk input yields a sane value
 * instead of throwing inside somebody's render loop.
 */
export const CORE_VERSION = '0.1.0';

export * from './time.js';
export * from './cards.js';
export * from './terminal-grid.js';
export * from './viewport.js';
export * from './metrics.js';
export * from './usage.js';
export * from './services.js';
export * from './listeners.js';
export * from './commit-graph.js';
export * from './terminal-keys.js';
