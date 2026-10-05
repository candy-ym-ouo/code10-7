-- 分享链接：密码错误锁定（password_failures / locked_until）+ 访问明细表（share_link_accesses）

-- AlterTable
ALTER TABLE "share_links"
    ADD COLUMN "password_failures" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "locked_until" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "ShareAccessEvent" AS ENUM ('view', 'password_fail', 'password_locked');

-- CreateTable
CREATE TABLE "share_link_accesses" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "event" "ShareAccessEvent" NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_link_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "share_link_accesses_share_link_id_created_at_idx" ON "share_link_accesses"("share_link_id", "created_at");

-- AddForeignKey
ALTER TABLE "share_link_accesses" ADD CONSTRAINT "share_link_accesses_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
