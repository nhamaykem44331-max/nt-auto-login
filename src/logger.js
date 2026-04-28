'use strict';

const chalk = require('chalk');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;
const MASK_PII = process.env.MASK_PII !== 'false';

function maskName(name) {
  if (!MASK_PII) return name;
  if (!name || typeof name !== 'string') return name;
  return name
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      return word[0] + '*'.repeat(Math.max(word.length - 1, 1));
    })
    .join(' ');
}

function maskPhone(phone) {
  if (!MASK_PII) return phone;
  if (!phone || typeof phone !== 'string') return phone;
  const cleaned = phone.trim();
  if (cleaned.length < 5) return '*'.repeat(cleaned.length);
  const prefix = cleaned.startsWith('+84') ? '+84' : cleaned.slice(0, 3);
  const suffix = cleaned.slice(-2);
  const stars = '*'.repeat(Math.max(cleaned.length - prefix.length - 2, 1));
  return `${prefix}${stars}${suffix}`;
}

function maskEmail(email) {
  if (!MASK_PII) return email;
  if (!email || typeof email !== 'string') return email;
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return email;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  if (local.length === 0) return email;
  return local[0] + '*'.repeat(Math.max(local.length - 1, 1)) + domain;
}

const PHONE_PATTERN = /(?<!\d)(\+?84|0)\d{8,10}(?!\d)/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function maskPII(text) {
  if (!MASK_PII) return text;
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(PHONE_PATTERN, (match) => maskPhone(match))
    .replace(EMAIL_PATTERN, (match) => maskEmail(match));
}

const PII_FIELDS = ['firstName', 'lastName', 'fullName', 'phone', 'phoneNumber', 'email', 'dienThoai', 'ngaySinh'];

function maskPassenger(obj) {
  if (!MASK_PII) return obj;
  if (!obj || typeof obj !== 'object') return obj;
  const masked = { ...obj };
  for (const field of PII_FIELDS) {
    if (masked[field] !== undefined) {
      if (field === 'email') {
        masked[field] = maskEmail(String(masked[field]));
      } else if (field === 'phone' || field === 'phoneNumber' || field === 'dienThoai') {
        masked[field] = maskPhone(String(masked[field]));
      } else {
        masked[field] = maskName(String(masked[field]));
      }
    }
  }
  return masked;
}

function format(args) {
  return args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
}

const logger = {
  debug(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.debug) {
      process.stdout.write(chalk.gray('[DEBUG] ' + format(args)) + '\n');
    }
  },
  info(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      process.stdout.write(format(args) + '\n');
    }
  },
  warn(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.warn) {
      process.stdout.write(chalk.yellow('[WARN] ' + format(args)) + '\n');
    }
  },
  error(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.error) {
      process.stderr.write(chalk.red('[ERROR] ' + format(args)) + '\n');
    }
  },
  success(...args) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) {
      process.stdout.write(chalk.green(format(args)) + '\n');
    }
  },
  maskPII,
  maskPassenger,
  maskName,
  maskPhone,
  maskEmail,
};

module.exports = logger;
