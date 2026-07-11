declare module "*.md" {
  /** Raw file contents, inlined at build time by the webpack `asset/source` rule. */
  const src: string;
  export default src;
}
