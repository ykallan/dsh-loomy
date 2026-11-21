/**
 * 兜底声明：首次构建（还没生成 `x.module.css.d.ts`）之前也能过 typecheck。
 *
 * 构建时 `scripts/dsh-css.mjs` 会在每个 `.module.css` 旁边写出逐类名的精确声明，
 * 那个文件会盖过这里的宽泛声明。
 */
declare module '*.module.css' {
  const styles: Readonly<Record<string, string>>
  export default styles
}
