#!/usr/bin/env node

const { runLogin } = require('./session-login');
const { MuadiApiClient, MuadiApiError } = require('./muadi-client');
const {
  formatMoney,
  holdFlight,
  priceFlight,
  routeSummaryOf,
  searchJourney,
  summarizeHoldResult,
} = require('./booking-workflow');
const { searchAirport, getAirportInfo } = require('./airports');
const logger = require('./logger');

function timed(label) {
  const start = Date.now();
  return {
    end: () => {
      const ms = Date.now() - start;
      logger.debug(`[${ms}ms] ${label}`);
      return ms;
    },
  };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith('--')) {
      const key = item
        .slice(2)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

function requireArgs(args, keys) {
  const missing = keys.filter((key) => args[key] === undefined || args[key] === '');
  if (missing.length) {
    throw new Error(`Missing required options: ${missing.map((key) => `--${key}`).join(', ')}`);
  }
}

function requirePassengerArgs(args) {
  if (args.passenger) return;
  if (args.lastName && args.firstName) return;
  throw new Error('Missing passenger. Use --passenger "MR Vu Duc Anh" or --title MR --last-name VU --first-name "DUC ANH".');
}

function commandParams(args) {
  return {
    from: args.from,
    to: args.to,
    date: args.date,
    returnDate: args.returnDate,
    airline: args.airline,
    time: args.time,
    flightNumber: args.flight,
    returnTime: args.returnTime,
    returnFlightNumber: args.returnFlight,
    returnAirline: args.returnAirline,
    directOnly: !!args.directOnly,
    adt: args.adt || 1,
    chd: args.chd || 0,
    inf: args.inf || 0,
    passenger: args.passenger,
    title: args.title,
    lastName: args.lastName,
    firstName: args.firstName,
    phone: args.phone,
    email: args.email,
    contactName: args.contactName,
    extraInfo: args.extraInfo,
    dryRun: !!args.dryRun,
  };
}

function shouldRetryWithLogin(error) {
  if (!(error instanceof MuadiApiError)) return false;
  if (error.safeToRetry === false) return false;
  return error.status === 401;
}

async function withAutoLogin(operation, args) {
  if (args.freshLogin) {
    logger.info('Refreshing Nam Thanh session...');
    await runLogin({ headless: !args.showBrowser });
  }

  let client = new MuadiApiClient();
  try {
    return await operation(client);
  } catch (error) {
    if (!shouldRetryWithLogin(error)) throw error;
    logger.info('Session expired. Logging in again and retrying once...');
    await runLogin({ headless: !args.showBrowser });
    client = new MuadiApiClient();
    return operation(client);
  }
}

function printJson(data) {
  logger.info(JSON.stringify(data, null, 2));
}

function printFlightSummary(s, label) {
  const prefix = label ? `${label}: ` : '';
  logger.info(`${prefix}${s.flightNumber} ${s.route || `${s.from}-${s.to}`}`);
  logger.info(`  Time: ${s.departDate} -> ${s.arrivalDate}`);
  logger.info(`  Class: ${s.class} ${s.cabinClass}`);
  logger.info(`  Seat: ${s.seatAvailable === undefined ? '-' : s.seatAvailable}`);
  logger.info(`  Fare: ${formatMoney(s.fareADT, s.currencyCode)} + Tax ${formatMoney(s.taxADT, s.currencyCode)} + VAT ${formatMoney(s.vatADT, s.currencyCode)}`);
  if (s.issueFeeADT) logger.info(`  Issue fee: ${formatMoney(s.issueFeeADT, s.currencyCode)}`);
  logger.info(`  Total: ${formatMoney(s.total, s.currencyCode)}`);
}

function printPrice(result) {
  logger.info('PRICE RESULT');
  logger.info(`Session: ${result.request.sessionID}`);
  if (result.isRoundtrip) {
    printFlightSummary(result.summary, 'Outbound');
    printFlightSummary(result.returnSummary, 'Return');
    logger.info(`Grand total: ${formatMoney(result.total, result.summary.currencyCode)}`);
  } else {
    const s = result.summary;
    logger.info(`Flight: ${s.flightNumber} ${s.route || `${s.from}-${s.to}`}`);
    logger.info(`Time: ${s.departDate} -> ${s.arrivalDate}`);
    logger.info(`Class: ${s.class} ${s.cabinClass}`);
    logger.info(`Seat: ${s.seatAvailable === undefined ? '-' : s.seatAvailable}`);
    logger.info(`Fare: ${formatMoney(s.fareADT, s.currencyCode)}`);
    logger.info(`Tax: ${formatMoney(s.taxADT, s.currencyCode)}`);
    logger.info(`VAT: ${formatMoney(s.vatADT, s.currencyCode)}`);
    logger.info(`Issue fee: ${formatMoney(s.issueFeeADT, s.currencyCode)}`);
    logger.info(`Total with tax/fees: ${formatMoney(s.total, s.currencyCode)}`);
  }
}

function printJourney(result) {
  logger.info('JOURNEY RESULT');
  logger.info(`Session: ${result.request.sessionID}`);
  logger.info(`Route: ${result.request.originCode}-${result.request.destinationCode}`);
  logger.info(`Date: ${result.request.departureDateTime}`);
  logger.info(`Sign-in airlines: ${result.signIns.join(', ')}`);
  Object.entries(result.byAirline).forEach(([airline, flights]) => {
    logger.info(`${airline}: ${flights.length} flights`);
  });
}

function maskedPassengerStr(passenger) {
  const ln = logger.maskName(passenger.lastName);
  const fn = logger.maskName(passenger.firstName);
  return `${passenger.title} ${ln}/${fn}`;
}

function printHold(result) {
  const passenger = result.passenger;
  const passengerStr = maskedPassengerStr(passenger);

  if (result.dryRun) {
    const label = result.isRoundtrip ? 'DRY RUN - ROUNDTRIP' : 'DRY RUN - ONEWAY';
    logger.info(`${label} - booking was not created.`);
    logger.info(`Passenger: ${passengerStr}`);
    printPrice(result);
    return;
  }

  const summary = summarizeHoldResult(result);
  const label = result.isRoundtrip ? 'HOLD RESULT (ROUNDTRIP)' : 'HOLD RESULT';
  logger.success(label);
  logger.info(`Session: ${summary.sessionID}`);
  logger.info(`Passenger: ${logger.maskPII(summary.passenger)}`);
  if (result.isRoundtrip && result.returnSummary) {
    const rs = result.returnSummary;
    logger.info(`Outbound: ${summary.flight.flightNumber} ${summary.flight.route || `${summary.flight.from}-${summary.flight.to}`} (${formatMoney(summary.flight.total, summary.flight.currencyCode)})`);
    logger.info(`Return:   ${rs.flightNumber} ${rs.route || `${rs.from}-${rs.to}`} (${formatMoney(rs.total, rs.currencyCode)})`);
    logger.info(`Total: ${formatMoney(result.total, summary.flight.currencyCode)}`);
  } else {
    logger.info(`Flight: ${summary.flight.flightNumber} ${summary.flight.route || `${summary.flight.from}-${summary.flight.to}`}`);
    logger.info(`Class: ${summary.flight.class} ${summary.flight.cabinClass}`);
    logger.info(`Total with tax/fees: ${formatMoney(summary.flight.total, summary.flight.currencyCode)}`);
  }
  summary.pnrs.forEach((item) => {
    logger.success(`PNR: ${item.pnr || '-'} | ${item.airline || '-'} | ${item.status || '-'}`);
    if (item.timelimit) logger.info(`Time limit: ${item.timelimit}`);
    if (item.message && item.message !== item.pnr) logger.info(`Message: ${item.message}`);
  });
}

function printHelp() {
  logger.info(`
Nam Thanh direct Muadi API workflow

Commands:
  login
  journey  --from HAN --to SGN --date 21-04-2026 [--airline VN] [--direct-only]
  price    --from HAN --to SGN --date 21-04-2026 --airline VN --time 05:00
  price    --from HAN --to SGN --date 21-04-2026 --return-date 30-04-2026 --airline VN --time 05:00 --return-time 14:00
  hold     --from HAN --to SGN --date 21-04-2026 --airline VN --time 05:00 --passenger "MR Vu Duc Anh" [--dry-run]
  hold     --from HAN --to SGN --date 21-04-2026 --return-date 30-04-2026 --airline VN --time 05:00 --return-time 14:00 --passenger "MR Vu Duc Anh"
  airports --search "Hà Nội"
  airports --info HAN
  airports --list domestic
  airports --list international

Options:
  --fresh-login     Login before running the command.
  --show-browser    Show browser during login.
  --json            Print raw JSON.
  --dry-run         For hold: build booking payload without creating a PNR.
  --direct-only     Exclude connecting flights.
  --return-date     Return date for roundtrip (DD-MM-YYYY).
  --return-time     Return flight departure time (HH:mm).
  --return-flight   Return flight number (e.g. VN218).
  --return-airline  Airline for return leg if different from outbound.
  --phone           Override contact phone for hold.
  --email           Override contact email for hold.
  --contact-name    Override contact name for hold.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';

  if (command === 'help' || args.help) {
    printHelp();
    return;
  }

  if (command === 'login') {
    await runLogin({ headless: !args.showBrowser });
    logger.success('Login OK. Session was saved.');
    return;
  }

  if (command === 'journey') {
    requireArgs(args, ['from', 'to', 'date']);
    const timer = timed('searchJourney total');
    let result;
    try {
      result = await withAutoLogin(
        (client) => searchJourney(commandParams(args), { client }),
        args
      );
    } finally {
      timer.end();
    }
    args.json ? printJson(result) : printJourney(result);
    return;
  }

  if (command === 'price') {
    requireArgs(args, ['from', 'to', 'date']);
    const timer = timed('priceFlight total');
    let result;
    try {
      result = await withAutoLogin(
        (client) => priceFlight(commandParams(args), { client }),
        args
      );
    } finally {
      timer.end();
    }
    args.json ? printJson({ request: result.request, summary: result.summary }) : printPrice(result);
    return;
  }

  if (command === 'hold') {
    requireArgs(args, ['from', 'to', 'date']);
    requirePassengerArgs(args);
    const timer = timed('holdFlight total');
    let result;
    try {
      result = await withAutoLogin(
        (client) => holdFlight(commandParams(args), { client, dryRun: !!args.dryRun }),
        args
      );
    } finally {
      timer.end();
    }
    args.json ? printJson(result.dryRun ? { request: result.request, summary: result.summary, dryRun: true } : summarizeHoldResult(result)) : printHold(result);
    return;
  }

  if (command === 'airports') {
    if (args.info) {
      const info = getAirportInfo(String(args.info).toUpperCase());
      if (!info) {
        logger.error(`Unknown airport: ${args.info}`);
        process.exit(1);
      }
      logger.info(`${info.code}  ${info.city.padEnd(20)} ${info.name.padEnd(40)} ${info.country} (${info.domestic ? 'domestic' : 'international'})`);
      return;
    }
    if (args.list) {
      const filter = String(args.list).toLowerCase();
      const all = require('../data/airports.json');
      const results = all.filter((a) => {
        if (filter === 'domestic') return a.domestic === true;
        if (filter === 'international') return a.domestic === false;
        return true;
      });
      results.forEach((a) => {
        logger.info(`${a.code}  ${a.city.padEnd(20)} ${a.name.padEnd(40)} ${a.country} (${a.domestic ? 'domestic' : 'international'})`);
      });
      logger.info(`\nTotal: ${results.length} airports`);
      return;
    }
    if (args.search) {
      const results = searchAirport(String(args.search));
      if (!results.length) {
        logger.info(`No airports found for: "${args.search}"`);
        return;
      }
      logger.info(`Found ${results.length} airport(s):`);
      results.forEach((a) => {
        logger.info(`  ${a.code}  ${a.city.padEnd(20)} ${a.name.padEnd(40)} ${a.country} (${a.domestic ? 'domestic' : 'international'})`);
      });
      return;
    }
    logger.error('Use --search <query>, --info <CODE>, or --list domestic|international');
    process.exit(1);
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  logger.error(`ERROR: ${error.message}`);
  if (error.data) {
    logger.error(JSON.stringify(error.data, null, 2));
  }
  process.exit(1);
});
