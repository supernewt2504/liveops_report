# Docker Hub 접속 불안정(빌더에서 registry-1.docker.io 연결 실패) 대비: AWS ECR Public 미러(도커 공식 이미지) 사용
FROM public.ecr.aws/docker/library/node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# 런타임 데이터·대시보드 산출물은 영구 볼륨에 저장 (Railway Volume 마운트 경로)
ENV DATA_DIR=/data
EXPOSE 3000

# 서버가 토큰 리포트 서빙 + 일일 스케줄러를 함께 구동
CMD ["node", "server/server.mjs"]
