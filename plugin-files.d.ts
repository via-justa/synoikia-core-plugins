// Data files a plugin imports; `synoikia-plugin build` inlines them into the bundle.
declare module '*.yaml' {
  const value: unknown;
  export default value;
}

declare module '*.md' {
  const text: string;
  export default text;
}
