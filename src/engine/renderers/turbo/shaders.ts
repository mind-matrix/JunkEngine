import vertexSource from "./shaders/vertex.wgsl";
import fragmentSource from "./shaders/fragment.wgsl";
import outlineSource from "./shaders/outline.wgsl";
import fxaaSource from "./shaders/fxaa.wgsl";
import txaaSource from "./shaders/txaa.wgsl";

/** Maximum number of lights supported per frame. */
export const MAX_LIGHTS = 16;

/** WGSL vertex shader source. */
export const VERTEX_SHADER: string = vertexSource;

/** WGSL fragment shader source with MAX_LIGHTS substituted. */
export const FRAGMENT_SHADER: string = fragmentSource.replace(/PLACEHOLDER_MAX_LIGHTS/g, `${MAX_LIGHTS}u`);

/** WGSL outline post-process shader source. */
export const OUTLINE_SHADER: string = outlineSource;

/** WGSL FXAA post-process shader source. */
export const FXAA_SHADER: string = fxaaSource;

/** WGSL TXAA post-process shader source. */
export const TXAA_SHADER: string = txaaSource;
