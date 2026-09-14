declare module "imagetracerjs" {
  interface TraceOptions {
    blurradius: number;
    blurdelta: number;
    colorquantcycles: number;
    colorsampling: number;
    desc: boolean;
    layering: number;
    linefilter: boolean;
    ltres: number;
    mincolorratio: number;
    numberofcolors: number;
    pathomit: number;
    qtres: number;
    rightangleenhance: boolean;
    roundcoords: number;
    scale: number;
    strokewidth: number;
    viewbox: boolean;
  }

  interface ImageTracerApi {
    imagedataToSVG(
      image: { data: Uint8ClampedArray; height: number; width: number },
      options: TraceOptions,
    ): string;
  }

  const imageTracer: ImageTracerApi;
  export default imageTracer;
}
