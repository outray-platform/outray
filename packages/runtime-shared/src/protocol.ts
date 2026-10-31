import { Message } from "./types";

export class Protocol {
  static encode(message: Message): string {
    return JSON.stringify(message);
  }

  static decode(data: string): Message {
    return JSON.parse(data) as Message;
  }
}
