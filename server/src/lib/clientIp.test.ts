import { describe, expect, it } from 'vitest'
import { classifyClientIp, redactIpHint, routeGroupOf } from './clientIp.js'

describe('classifyClientIp', () => {
  it('classifies public IPv4 as public', () => {
    expect(classifyClientIp('203.0.113.50')).toBe('public')
    expect(classifyClientIp('8.8.8.8')).toBe('public')
  })

  it('classifies loopback as loopback', () => {
    expect(classifyClientIp('127.0.0.1')).toBe('loopback')
    expect(classifyClientIp('127.255.255.255')).toBe('loopback')
    expect(classifyClientIp('::1')).toBe('loopback')
  })

  it('classifies RFC1918, link-local, and CGNAT as private', () => {
    expect(classifyClientIp('10.0.0.1')).toBe('private')
    expect(classifyClientIp('172.16.0.1')).toBe('private')
    expect(classifyClientIp('172.31.255.255')).toBe('private')
    expect(classifyClientIp('192.168.208.1')).toBe('private')
    expect(classifyClientIp('169.254.1.1')).toBe('private')
    expect(classifyClientIp('100.64.0.1')).toBe('private')
    expect(classifyClientIp('100.127.255.254')).toBe('private')
  })

  it('does not treat 172.32/100.63/100.128 as private', () => {
    expect(classifyClientIp('172.32.0.1')).toBe('public')
    expect(classifyClientIp('100.63.255.255')).toBe('public')
    expect(classifyClientIp('100.128.0.1')).toBe('public')
  })

  it('classifies IPv6 ULA and link-local as private', () => {
    expect(classifyClientIp('fd12:3456:789a::1')).toBe('private')
    expect(classifyClientIp('fc00::1')).toBe('private')
    expect(classifyClientIp('fe80::1')).toBe('private')
  })

  it('classifies unspecified and unparseable values as invalid', () => {
    expect(classifyClientIp('0.0.0.0')).toBe('invalid')
    expect(classifyClientIp('::')).toBe('invalid')
    expect(classifyClientIp('not-an-ip')).toBe('invalid')
    expect(classifyClientIp('')).toBe('invalid')
    expect(classifyClientIp(null)).toBe('invalid')
    expect(classifyClientIp(' 203.0.113.50 ')).toBe('invalid')
  })

  it('strips IPv4-mapped IPv6 before classifying', () => {
    expect(classifyClientIp('::ffff:192.168.1.10')).toBe('private')
    expect(classifyClientIp('::ffff:203.0.113.50')).toBe('public')
    expect(classifyClientIp('::ffff:127.0.0.1')).toBe('loopback')
  })
})

describe('redactIpHint', () => {
  it('redacts public IPv4 to a /24 hint and keeps public IPv6 opaque', () => {
    expect(redactIpHint('203.0.113.50')).toBe('203.0.113.*')
    expect(redactIpHint('2001:db8::1')).toBe('IPv6 地址')
  })

  it('hides loopback, private, CGNAT, ULA, and invalid addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.208.1',
      '100.64.1.2',
      '169.254.0.1',
      '::1',
      'fd00::1',
      'fe80::abcd',
      '0.0.0.0',
      'not-an-ip',
      '',
      null,
    ]) {
      expect(redactIpHint(ip), String(ip)).toBe('未知 IP')
    }
  })
})

describe('routeGroupOf', () => {
  it('uses the first API segment and never treats raw IPs as a label', () => {
    expect(routeGroupOf('/api/auth/login')).toBe('auth')
    expect(routeGroupOf('/api/payment/webhooks/vmqfox')).toBe('payment')
    expect(routeGroupOf('/api')).toBe('root')
    expect(routeGroupOf('/')).toBe('root')
    expect(routeGroupOf('/api/203.0.113.50')).toBe('other')
  })
})
