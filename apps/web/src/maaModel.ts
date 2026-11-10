// The single import point of the shared Windows task model (pure TypeScript, no Node APIs).
// The server owns the module because it compiles authoritatively at dispatch; the editor uses the
// same code for defaults, form spec, neutral compile on save and migration checks.
export * from '../../server/src/maa-model';
