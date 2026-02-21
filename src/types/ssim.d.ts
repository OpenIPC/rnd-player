declare module "ssim.js" {
  interface Matrix {
    data: number[];
    width: number;
    height: number;
  }
  interface SSIMResult {
    mssim: number;
    ssim_map: Matrix;
    performance: number;
  }
  type Algorithm = "original" | "fast" | "bezkrovny" | "weber";
  interface SSIMOptions {
    ssim?: Algorithm;
    downsample?: boolean;
  }
  function ssim(
    imageA: ImageData,
    imageB: ImageData,
    options?: SSIMOptions,
  ): SSIMResult;
  export default ssim;
  export { ssim };
}
