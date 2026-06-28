import { Scene } from "./Scene";

/**
 * Abstract base for scene importers.
 * @typeParam T - The serialized input type (e.g. ArrayBuffer, string).
 */
export abstract class Importer<T = Scene> {
    /** Deserializes data into a Scene. */
    abstract import(data: T): Scene;
    /** Deserializes a UTF-8 string representation into a Scene. */
    abstract importFromString(str: string): Scene;
}
