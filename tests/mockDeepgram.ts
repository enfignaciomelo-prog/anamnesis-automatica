import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { ConnectDeepgram } from "../server/transcription/deepgram";

export async function mockDeepgram() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const connections: WebSocket[] = [];
  const requests: URL[] = [];
  const counts: number[] = [];

  server.on("connection", (socket) => {
    const index = connections.push(socket) - 1;
    counts[index] = 0;
    const send = (is_final: boolean, start: number, transcript: string, words: object[]) => socket.send(JSON.stringify({
      type: "Results", is_final, start, channel: { alternatives: [{ transcript, words }] },
    }));
    socket.on("message", (data, binary) => {
      if (binary) {
        counts[index]++;
        if (counts[index] !== 1) return;
        send(false, 0, "Me tinca", []);
        const words = [
          { word: "me", punctuated_word: "Me", start: 0, end: 0.05, speaker: 0 },
          { word: "tinca", punctuated_word: "tinca.", start: 0.05, end: 0.15, speaker: 0 },
          { word: "ya", punctuated_word: "Ya.", start: 0.15, end: 0.25, speaker: 1 },
        ];
        send(true, 0, "Me tinca. Ya.", words);
        send(true, 0, "Me tinca. Ya.", words);
      } else if (String(data) === JSON.stringify({ type: "CloseStream" })) {
        send(true, 0.25, "Me duele la guata.", [
          { word: "me", punctuated_word: "Me", start: 0.25, end: 0.3, speaker: 0 },
          { word: "duele", start: 0.3, end: 0.35, speaker: 0 },
          { word: "la", start: 0.35, end: 0.4, speaker: 0 },
          { word: "guata", punctuated_word: "guata.", start: 0.4, end: 0.5, speaker: 0 },
        ]);
        socket.close(1000);
      }
    });
  });
  const connect: ConnectDeepgram = (url, options) => {
    requests.push(url);
    return new WebSocket(`ws://127.0.0.1:${port}`, options);
  };
  const close = async () => {
    for (const socket of connections) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { connect, close, connections, requests, counts };
}
