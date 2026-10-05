-- CreateEnum
CREATE TYPE "ShareAccessKind" AS ENUM ('view', 'media');

-- AlterTable: 分享链接增加密码错误次数与锁定时间
ALTER TABLE "share_links" ADD COLUMN "password_fail_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "share_links" ADD COLUMN "locked_until" TIMESTAMP(3);

-- AlterTable: 链接内条目支持单独失效（软移除，保留审计与访问明细）
ALTER TABLE "share_link_items" ADD COLUMN "removed_at" TIMESTAMP(3);
ALTER TABLE "share_link_items" ADD COLUMN "removed_by" TEXT;

-- CreateTable: 公开访问明细（浏览条目 / 读取媒体）
CREATE TABLE "share_accesses" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "kind" "ShareAccessKind" NOT NULL,
    "item_id" TEXT,
    "media_id" TEXT,
    "outcome" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "share_link_items_share_link_id_removed_at_idx" ON "share_link_items"("share_link_id", "removed_at");
CREATE INDEX "share_accesses_share_link_id_created_at_idx" ON "share_accesses"("share_link_id", "created_at");
CREATE INDEX "share_accesses_share_link_id_item_id_created_at_idx" ON "share_accesses"("share_link_id", "item_id", "created_at");

-- AddForeignKey
ALTER TABLE "share_accesses" ADD CONSTRAINT "share_accesses_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_accesses" ADD CONSTRAINT "share_accesses_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
