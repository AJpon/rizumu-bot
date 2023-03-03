import Rizumu from "../Rizumu";
import RizumuItem from "../RizumuItem";

type TypeDef<T> = new (...args: any) => T;

export interface RizumuProvider
{
    get itemClassDefinition(): TypeDef<RizumuItem>;
    match(url: URL): boolean;
    processAsync(url: URL, emitItem: (item: RizumuItem) => void): Promise<void>;
    playItemAsync(rizumu: Rizumu, item: RizumuItem): Promise<void>;
}