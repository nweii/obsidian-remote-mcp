// Treat web-clipper-headless as opaque to TS — clip.ts declares the shape it needs locally.
// The package's source uses .ts extension imports that aren't compatible with this tsconfig;
// at runtime Bun handles them natively.
declare module "web-clipper-headless" {
  const value: unknown;
  export = value;
}
