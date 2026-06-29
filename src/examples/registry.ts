export interface DemoEntry {
    id: string;
    name: string;
    description: string;
    tags: string[];
    create: () => { start: (canvas: HTMLCanvasElement) => Promise<void> };
}

const demos: DemoEntry[] = [];

export function registerDemo(entry: DemoEntry): void {
    demos.push(entry);
}

export function getDemos(): DemoEntry[] {
    return demos;
}

export function getDemo(id: string): DemoEntry | undefined {
    return demos.find((d) => d.id === id);
}
