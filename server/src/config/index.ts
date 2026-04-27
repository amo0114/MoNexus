export const config = {
  port: parseInt(process.env.PORT || '3000'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  checkinReward: 50,
  registerReward: 500,
  inviteReward: 200,
}
