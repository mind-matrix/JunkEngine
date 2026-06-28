type Method = (...args: unknown[]) => unknown;

export function timeit(_target: object, propertyKey: string, descriptor: TypedPropertyDescriptor<Method>) {
    const originalMethod = descriptor.value;
    if (originalMethod === undefined) return;

    descriptor.value = function (this: { constructor: { name: string } }, ...args: unknown[]): unknown {
        const className = this.constructor.name;
        const startMarker = `${className}:${propertyKey}#START`;
        const endMarker = `${className}:${propertyKey}#END`;
        const timeMeasure = `${className}:${propertyKey}#TIME`;
        performance.clearMarks(startMarker);
        performance.mark(startMarker);
        const result: unknown = originalMethod.apply(this, args);

        if (result instanceof Promise) {
            return result.then((value: unknown) => {
                performance.clearMarks(endMarker);
                performance.mark(endMarker);
                performance.clearMeasures(timeMeasure);
                performance.measure(timeMeasure, startMarker, endMarker);
                return value;
            });
        } else {
            performance.clearMarks(endMarker);
            performance.mark(endMarker);
            performance.clearMeasures(timeMeasure);
            performance.measure(timeMeasure, startMarker, endMarker);
            return result;
        }
    };
}
