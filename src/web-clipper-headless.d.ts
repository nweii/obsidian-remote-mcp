// Typecheck stand-in for the optional web-clipper-headless package, wired in through `paths` in
// tsconfig.json so tsc never checks the package's raw .ts sources. clip.ts loads it dynamically
// and declares the shape it needs locally; at runtime Bun resolves the real package.
declare const value: unknown;
export default value;
