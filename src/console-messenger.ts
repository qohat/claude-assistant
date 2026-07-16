// Messenger de consola para pruebas locales sin bot real (AI_HOME_CONSOLE=1):
// stdin = mensajes del usuario, stdout = respuestas del orquestador.
import readline from 'node:readline';
import { Messenger } from './telegram.js';

export class ConsoleMessenger implements Messenger {
  private rl: readline.Interface | null = null;

  async send(text: string): Promise<void> {
    process.stdout.write(`\n🤖 ${text}\n> `);
  }

  async sendTyping(): Promise<void> {
    // sin equivalente en consola
  }

  async setCommands(): Promise<void> {
    // sin equivalente en consola
  }

  pollLoop(onMessage: (text: string) => void): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    this.rl.prompt();
    return new Promise(resolve => {
      this.rl!.on('line', line => {
        const text = line.trim();
        if (text) onMessage(text);
        this.rl?.prompt();
      });
      this.rl!.on('close', resolve);
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }
}
