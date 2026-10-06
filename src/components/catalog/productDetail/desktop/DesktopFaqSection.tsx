import { Check, Headphones, ShieldCheck, Zap } from 'lucide-react'
import type { FaqItem } from '../../productDetailFaq'
import ProductFaqAccordion from '../../ProductFaqAccordion'
import { resolveDisplayFaqs } from '../../productDetailFaq'

interface DesktopFaqSectionProps {
  faq?: FaqItem[] | null
  onOpenSupport: () => void
}

/**
 * FAQ tab content: fulfillment pipeline card, categorized QA accordions and the
 * support contact card. The accordion itself stays in ProductFaqAccordion; this
 * section only owns the FAQ hub composition.
 */
export default function DesktopFaqSection({ faq, onOpenSupport }: DesktopFaqSectionProps) {
  return (
    <div className="pd-faq-hub" id="product-section-faq">
      <div className="pd-faq-hub-header">
        <div>
          <h2>交付履约与常见解答</h2>
          <p className="pd-faq-hub-subtitle">数字服务自动化秒发、凭据调配与平台争议存管保障</p>
        </div>
        <div className="pd-faq-system-status">
          <span className="pd-pulse-dot" />
          <span>自动直发引擎运行中</span>
        </div>
      </div>

      <div className="pd-faq-hub-grid">
        {/* Left: 4-Step Fulfillment Pipeline Card */}
        <div className="pd-faq-pipeline-card">
          <div className="pd-pipeline-title">
            <Zap size={15} />
            <span>数字资产履约全流程</span>
          </div>
          <div className="pd-pipeline-stepper">
            <div className="pd-pipeline-step">
              <div className="pd-step-marker">1</div>
              <div className="pd-step-content">
                <strong>选择套餐并确认兑换</strong>
                <p>积分/资金实时托管，生成防篡改订单号</p>
              </div>
            </div>
            <div className="pd-pipeline-step">
              <div className="pd-step-marker">2</div>
              <div className="pd-step-content">
                <strong>云端智能调配卡密</strong>
                <p>独占配发可用凭据，防并发与重复使用</p>
              </div>
            </div>
            <div className="pd-pipeline-step">
              <div className="pd-step-marker">3</div>
              <div className="pd-step-content">
                <strong>订单详情即时查验</strong>
                <p>弹窗或「我的订单」直接复制卡密与指引</p>
              </div>
            </div>
            <div className="pd-pipeline-step">
              <div className="pd-step-marker">4</div>
              <div className="pd-step-content">
                <strong>平台争议存管介入</strong>
                <p>若遇凭据异常，可一键申请售后仲裁保障</p>
              </div>
            </div>
          </div>

          <div className="pd-pipeline-badges">
            <div className="pd-pipeline-badge-item">
              <ShieldCheck size={13} />
              <span>资金平台存管</span>
            </div>
            <div className="pd-pipeline-badge-item">
              <Check size={13} />
              <span>凭据不可篡改</span>
            </div>
          </div>
        </div>

        {/* Right: Categorized QA Accordions */}
        <div className="pd-faq-accordion-column">
          <div className="pd-faq-list">
            {resolveDisplayFaqs(faq).map((item, i) => (
              <ProductFaqAccordion
                key={i}
                question={item.question}
                answer={item.answer}
                defaultOpen={i === 0}
                prefix={<span className="pd-faq-num">0{i + 1}</span>}
                className="pd-faq-acc"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="pd-faq-contact-card">
        <div className="pd-faq-contact-info">
          <div className="pd-faq-contact-icon">
            <Headphones size={22} />
          </div>
          <div>
            <div className="pd-faq-contact-title">仍有关于本商品的其他疑问？</div>
            <div className="pd-faq-contact-desc">
              售前咨询、卡密核验及争议处理，如有关于本商品的问题，请联系商家客服。
            </div>
          </div>
        </div>
        <button type="button" className="pd-faq-contact-btn" onClick={onOpenSupport}>
          <Headphones size={15} />
          联系在线客服
        </button>
      </div>
    </div>
  )
}
