/**
 * vitest-react-native-runtime CLI
 *
 * Commands:
 *   init          Scaffold a new test harness Expo app
 *   build         Build the test harness app for a platform
 *   install       Boot a device and install the app
 *   bootstrap     Build + install in one step
 *   doctor        Check environment for Android/iOS development tools
 *   help          Show this help message
 */

export {};

const command: string | undefined = process.argv[2];

switch (command) {
  case 'init': {
    process.argv.splice(2, 1); // remove 'init', leaving [dir]
    await import('./init');
    break;
  }

  case 'build': {
    process.argv.splice(2, 1); // remove 'build', leaving [platform] [--app-dir ...]
    await import('./build');
    break;
  }

  case 'install': {
    process.argv.splice(2, 1); // remove 'install', leaving [platform] [--app-dir ...]
    await import('./install');
    break;
  }

  case 'bootstrap': {
    process.argv.splice(2, 1); // remove 'bootstrap', leaving [platform] [--app-dir ...]
    await import('./bootstrap');
    break;
  }

  case 'doctor': {
    const { runDoctor } = await import('./doctor');
    process.exit(runDoctor());
    break;
  }

  case 'boot-device': {
    process.argv.splice(2, 1); // remove 'boot-device', leaving [platform]
    await import('./boot-device');
    break;
  }

  case 'screenshot': {
    process.argv.splice(2, 1); // remove 'screenshot', leaving [--platform ...] [--output ...]
    await import('./screenshot');
    break;
  }

  case 'resume': {
    process.argv.splice(2, 1); // remove 'resume', leaving [--app-dir ...]
    await import('./resume');
    break;
  }

  case 'debug': {
    process.argv.splice(2, 1); // remove 'debug', leaving [subcommand] [args...]
    await import('./debug');
    break;
  }

  case 'status': {
    process.argv.splice(2, 1);
    await import('./status');
    break;
  }

  case 'logs': {
    process.argv.splice(2, 1);
    await import('./logs');
    break;
  }

  case 'kill': {
    process.argv.splice(2, 1);
    await import('./kill');
    break;
  }

  case 'tap': {
    process.argv.splice(2, 1);
    await import('./tap');
    break;
  }

  case 'type-text': {
    process.argv.splice(2, 1);
    await import('./type-text');
    break;
  }

  case 'tree': {
    process.argv.splice(2, 1);
    await import('./tree');
    break;
  }

  case 'console': {
    process.argv.splice(2, 1);
    await import('./console');
    break;
  }

  case 'start': {
    process.argv.splice(2, 1);
    await import('./start');
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  case undefined: {
    console.log(`
  vitest-react-native-runtime — Native component testing for React Native

  Commands:
    init           Scaffold a new test harness Expo app
    build          Build the test harness app for a platform
    install        Boot a device/emulator and install the app
    bootstrap      Build + install in one step
    doctor         Check your environment for Android/iOS development tools
    boot-device    Start a simulator or emulator
    screenshot     Take a screenshot of the running emulator/simulator
    resume         Resume a paused test
    debug          CDP debugger tools (eval, status, logs)
    status         Health check — simulator, app, Metro, WS
    logs           Read Metro or device logs
    kill           Kill stuck Metro/WS processes
    tap            Simulate a touch event at x,y coordinates
    type-text      Input text on the device
    tree           Dump the app's view hierarchy via CDP

  Usage:
    npx vitest-react-native-runtime init [directory]
    npx vitest-react-native-runtime build <android|ios> [--app-dir <path>]
    npx vitest-react-native-runtime install <android|ios> [--app-dir <path>]
    npx vitest-react-native-runtime bootstrap <android|ios> [--app-dir <path>]
    npx vitest-react-native-runtime doctor
    npx vitest-react-native-runtime boot-device <android|ios>
    npx vitest-react-native-runtime screenshot [--platform <android|ios>] [--output <path>]
    npx vitest-react-native-runtime resume [--app-dir <path>]
    npx vitest-react-native-runtime status [--platform <android|ios>]
    npx vitest-react-native-runtime logs [--lines N] [--device]
    npx vitest-react-native-runtime kill [--port <port>]
    npx vitest-react-native-runtime tap <x> <y> [--platform <android|ios>]
    npx vitest-react-native-runtime type-text "text" [--platform <android|ios>]
    npx vitest-react-native-runtime tree [--json]
    npx vitest-react-native-runtime debug eval|status|logs

  For running tests, add nativePlugin() to your vitest config:
    import { nativePlugin } from 'vitest-react-native-runtime';
`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}\nRun "npx vitest-react-native-runtime help" for available commands.`);
    process.exit(1);
}
