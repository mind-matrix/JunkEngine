import { Scene } from "./Scene";

/**
 * Abstract base for scene exporters.
 * @typeParam T - The serialized output type (e.g. ArrayBuffer, string).
 */
export abstract class Exporter<T = Scene> {
    /** Serializes a scene into the target format. */
    abstract export(scene: Scene): T;
    /** Serializes a scene into a UTF-8 string representation. */
    abstract exportToString(scene: Scene): string;
}
