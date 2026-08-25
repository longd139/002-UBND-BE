import { randomInt } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import LeaderMeetingRegistrationRepository from "../repositories/leader-meeting-registration.repository.js";
import { BaseError } from "../utils/base-error.util.js";
import { createPagination } from "../utils/response.util.js";
import { normalizeRoleNames } from "../utils/auth-context.util.js";
import { TRANG_THAI_GAP_LANH_DAO } from "../constants/trang-thai-gap-lanh-dao.constant.js";

const MAX_RETRIES = 10;
const PRIVATE_UPLOAD_ROOT = path.resolve(
  process.cwd(),
  "src",
  "private",
  "uploads",
  "leader-meetings"
);

const createCode = () => `LD${String(randomInt(0, 1000000)).padStart(6, "0")}`;

const vietnamDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const vietnamTime = (date = new Date()) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

const buildAttachments = (files = {}) => {
  const mapFile = (file, type) => ({
    loai_dinh_kem: type,
    ten_file_goc: Buffer.from(file.originalname, "latin1").toString("utf8"),
    duong_dan_file: path.relative(process.cwd(), file.path).replace(/\\/g, "/"),
    mime_type: file.mimetype,
    kich_thuoc: file.size,
  });

  return [
    ...(files.citizenIdFront || []).map((file) => mapFile(file, "CCCD_FRONT")),
    ...(files.citizenIdBack || []).map((file) => mapFile(file, "CCCD_BACK")),
    ...(files.supportingDocuments || []).map((file) =>
      mapFile(file, "SUPPORTING_DOCUMENT")
    ),
  ];
};

const conflictMessages = {
  SLOT_UNAVAILABLE: [404, "Khung giờ gặp lãnh đạo không tồn tại hoặc đã ngừng hoạt động"],
  SLOT_PASSED: [409, "Khung giờ gặp lãnh đạo đã qua"],
  SLOT_FULL: [409, "Khung giờ gặp lãnh đạo đã đủ sức chứa"],
  PHONE_DAILY_LIMIT: [409, "Số điện thoại đã có đăng ký giữ chỗ trong ngày hẹn này"],
  CITIZEN_DAILY_LIMIT: [409, "CCCD đã có đăng ký giữ chỗ trong ngày hẹn này"],
  PHONE_SLOT_ALREADY_USED: [
    409,
    "Số điện thoại đã từng đăng ký khung giờ này, vui lòng chọn khung giờ khác",
  ],
  CITIZEN_SLOT_ALREADY_USED: [
    409,
    "CCCD đã từng đăng ký khung giờ này, vui lòng chọn khung giờ khác",
  ],
};

const uniqueErrorText = (error) => {
  try {
    return `${error?.message || ""} ${JSON.stringify(error?.meta || {})}`.toLowerCase();
  } catch {
    return String(error?.message || "").toLowerCase();
  }
};

const mapUniqueConflict = (error) => {
  if (error?.code !== "P2002") return null;
  const text = uniqueErrorText(error);
  if (text.includes("uq_leader_meeting_slot_phone")) {
    return "PHONE_SLOT_ALREADY_USED";
  }
  if (text.includes("uq_leader_meeting_slot_citizen")) {
    return "CITIZEN_SLOT_ALREADY_USED";
  }
  if (text.includes("ngay_sdt") || text.includes("sdt")) return "PHONE_DAILY_LIMIT";
  if (text.includes("ngay_cccd") || text.includes("cccd")) return "CITIZEN_DAILY_LIMIT";
  return null;
};

const mapCreated = ({ registration, slot }) => ({
  id: registration.id,
  registrationCode: registration.ma_dang_ky,
  status: registration.trang_thai,
  receptionDate: vietnamDate(slot.lich_gap_lanh_dao.ngay),
  timeSlot: `${slot.gio_bat_dau} - ${slot.gio_ket_thuc}`,
  leaderName: slot.lich_gap_lanh_dao.lanh_dao.ho_va_ten,
});

const maskValue = (value, suffixLength = 4) => {
  if (!value) return null;
  const suffix = value.slice(-suffixLength);
  return `${"*".repeat(Math.max(0, value.length - suffixLength))}${suffix}`;
};

const mapCitizenLookup = (registration) => {
  const slot = registration.khung_gio_gap_lanh_dao;
  const schedule = slot.lich_gap_lanh_dao;
  return {
    id: registration.id,
    registrationCode: registration.ma_dang_ky,
    status: registration.trang_thai,
    receptionDate: vietnamDate(registration.ngay_hen),
    timeSlot: `${slot.gio_bat_dau} - ${slot.gio_ket_thuc}`,
    topic: registration.chu_de,
    reason: registration.ly_do,
    applicant: {
      fullName: registration.ho_ten,
      phoneNumber: maskValue(registration.sdt),
      citizenId: maskValue(registration.cccd),
      address: registration.dia_chi,
    },
    leader: {
      id: schedule.lanh_dao.id,
      fullName: schedule.lanh_dao.ho_va_ten,
    },
    location: schedule.dia_diem,
    rejectionReason: registration.ly_do_tu_choi,
    rejectedAt: registration.thoi_gian_tu_choi,
    cancellationReason: registration.ly_do_huy,
    canceledAt: registration.thoi_gian_huy,
    approvedAt: registration.thoi_gian_phe_duyet,
    processingAt: registration.thoi_gian_bat_dau_xu_ly,
    completedAt: registration.thoi_gian_hoan_thanh,
    ratingStatus: registration.danh_gia_gap_lanh_dao ? "RATED" : "NOT_RATED",
    createdAt: registration.thoi_gian_tao,
    updatedAt: registration.thoi_gian_cap_nhat,
  };
};

const mapManagementListItem = (registration) => {
  const slot = registration.khung_gio_gap_lanh_dao;
  const schedule = slot.lich_gap_lanh_dao;
  return {
    id: registration.id,
    registrationCode: registration.ma_dang_ky,
    applicant: {
      fullName: registration.ho_ten,
      phoneNumber: registration.sdt,
      citizenId: registration.cccd,
    },
    topic: registration.chu_de || registration.ly_do || "",
    reason: registration.ly_do || "",
    status: registration.trang_thai,
    receptionDate: vietnamDate(registration.ngay_hen),
    timeSlot: `${slot.gio_bat_dau} - ${slot.gio_ket_thuc}`,
    location: schedule.dia_diem,
    leader: {
      id: schedule.lanh_dao.id,
      fullName: schedule.lanh_dao.ho_va_ten,
    },
    processingResult: registration.ghi_chu_hoan_thanh || registration.ghi_chu_xu_ly || null,
    ratingStatus: registration.danh_gia_gap_lanh_dao ? "RATED" : "NOT_RATED",
    approvedAt: registration.thoi_gian_phe_duyet,
    processingAt: registration.thoi_gian_bat_dau_xu_ly,
    completedAt: registration.thoi_gian_hoan_thanh,
    rejectedAt: registration.thoi_gian_tu_choi,
    canceledAt: registration.thoi_gian_huy,
    createdAt: registration.thoi_gian_tao,
  };
};

const mapOperator = (operator, operatedAt) =>
  operator
    ? { id: operator.id, fullName: operator.ho_va_ten, operatedAt }
    : null;

const mapManagementDetail = (registration) => {
  const slot = registration.khung_gio_gap_lanh_dao;
  const schedule = slot.lich_gap_lanh_dao;
  return {
    id: registration.id,
    registrationCode: registration.ma_dang_ky,
    status: registration.trang_thai,
    applicationDate: registration.ngay_lam_don
      ? vietnamDate(registration.ngay_lam_don)
      : null,
    appointment: {
      date: vietnamDate(registration.ngay_hen),
      slotId: slot.id,
      startTime: slot.gio_bat_dau,
      endTime: slot.gio_ket_thuc,
      location: schedule.dia_diem,
      scheduleNote: schedule.ghi_chu,
      leader: {
        id: schedule.lanh_dao.id,
        fullName: schedule.lanh_dao.ho_va_ten,
        email: schedule.lanh_dao.email,
        phoneNumber: schedule.lanh_dao.so_dien_thoai,
      },
    },
    applicant: {
      fullName: registration.ho_ten,
      phoneNumber: registration.sdt,
      citizenId: registration.cccd,
      citizenIdIssuedDate: registration.ngay_cap_cccd
        ? vietnamDate(registration.ngay_cap_cccd)
        : null,
      citizenIdIssuedPlace: registration.noi_cap_cccd,
      address: registration.dia_chi,
    },
    topic: registration.chu_de,
    reason: registration.ly_do,
    workflow: {
      approver: mapOperator(
        registration.nguoi_duyet,
        registration.thoi_gian_phe_duyet
      ),
      processor: mapOperator(
        registration.nguoi_bat_dau_xu_ly_ref,
        registration.thoi_gian_bat_dau_xu_ly
      ),
      completer: mapOperator(
        registration.nguoi_hoan_thanh_ref,
        registration.thoi_gian_hoan_thanh
      ),
      rejecter: mapOperator(
        registration.nguoi_tu_choi_ref,
        registration.thoi_gian_tu_choi
      ),
      canceler: mapOperator(
        registration.nguoi_huy_ref,
        registration.thoi_gian_huy
      ),
      processingNote: registration.ghi_chu_xu_ly,
      completionNote: registration.ghi_chu_hoan_thanh,
      rejectionReason: registration.ly_do_tu_choi,
      cancellationReason: registration.ly_do_huy,
    },
    attachments: registration.dinh_kem_dang_ky_gap_lanh_dao.map((item) => ({
      id: item.id,
      type: item.loai_dinh_kem,
      originalName: item.ten_file_goc,
      mimeType: item.mime_type,
      size: item.kich_thuoc,
      createdAt: item.thoi_gian_tao,
      contentEndpoint: `/api/leader-meeting-registrations/${registration.id}/attachments/${item.id}`,
      canDownload: item.loai_dinh_kem === "SUPPORTING_DOCUMENT",
    })),
    rating: registration.danh_gia_gap_lanh_dao
      ? {
          id: registration.danh_gia_gap_lanh_dao.id,
          score: registration.danh_gia_gap_lanh_dao.diem_tong,
          criteria: registration.danh_gia_gap_lanh_dao.tieu_chi,
          reasons: registration.danh_gia_gap_lanh_dao.ly_do,
          comment: registration.danh_gia_gap_lanh_dao.nhan_xet,
          createdAt: registration.danh_gia_gap_lanh_dao.thoi_gian_tao,
        }
      : null,
    createdAt: registration.thoi_gian_tao,
    updatedAt: registration.thoi_gian_cap_nhat,
  };
};

const LeaderMeetingRegistrationService = {
  async create(input, files = {}) {
    const now = new Date();
    const attachments = buildAttachments(files);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const result = await LeaderMeetingRegistrationRepository.createWithGuards({
          slotId: input.slotId,
          phoneNumber: input.phoneNumber,
          citizenId: input.citizenId,
          currentDate: vietnamDate(now),
          currentTime: vietnamTime(now),
          attachments,
          data: {
            ma_dang_ky: createCode(),
            chu_de: input.topic || null,
            ho_ten: input.fullName,
            sdt: input.phoneNumber,
            cccd: input.citizenId,
            ngay_cap_cccd: input.citizenIdIssuedDate
              ? new Date(`${input.citizenIdIssuedDate}T00:00:00.000Z`)
              : null,
            noi_cap_cccd: input.citizenIdIssuedPlace || null,
            dia_chi: input.address,
            ngay_lam_don: new Date(`${vietnamDate(now)}T00:00:00.000Z`),
            ly_do: input.reason,
            trang_thai: "PENDING",
          },
        });

        if (result.conflict) {
          const [statusCode, message] = conflictMessages[result.conflict];
          throw new BaseError(statusCode, message);
        }

        return mapCreated(result);
      } catch (error) {
        const uniqueConflict = mapUniqueConflict(error);
        if (uniqueConflict) {
          throw new BaseError(...conflictMessages[uniqueConflict]);
        }
        if (error?.code === "P2034") {
          if (attempt === MAX_RETRIES - 1) {
            throw new BaseError(
              503,
              "Hệ thống đang xử lý nhiều đăng ký cùng lúc, vui lòng thử lại"
            );
          }
          continue;
        }
        if (error?.code === "P2002") {
          if (attempt === MAX_RETRIES - 1) {
            throw new BaseError(500, "Không thể tạo mã đăng ký gặp lãnh đạo");
          }
          continue;
        }
        throw error;
      }
    }

    throw new BaseError(500, "Không thể tạo mã đăng ký gặp lãnh đạo");
  },

  async lookup(input) {
    const registrations =
      await LeaderMeetingRegistrationRepository.findForCitizenLookup({
        registrationCode: input.registrationCode?.toUpperCase(),
        phoneNumber: input.phoneNumber,
      });
    if (registrations.length === 0) {
      throw new BaseError(404, "Không tìm thấy đăng ký gặp lãnh đạo");
    }
    return registrations.map(mapCitizenLookup);
  },

  async getManagementRegistrations(filters, currentUser) {
    if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) {
      throw new BaseError(400, "Ngày bắt đầu không được sau ngày kết thúc");
    }
    const roles = normalizeRoleNames(currentUser.roles);
    const canViewAll = roles.some((role) =>
      ["ADMIN", "APPROVER", "PHE_DUYET"].includes(role)
    );
    const result = await LeaderMeetingRegistrationRepository.findManagement({
      ...filters,
      leaderId: canViewAll ? filters.leaderId : currentUser.userId,
    });
    return {
      data: result.data.map(mapManagementListItem),
      pagination: createPagination(filters.page, filters.limit, result.totalItems),
    };
  },

  async getManagementDetail(id, currentUser) {
    const roles = normalizeRoleNames(currentUser.roles);
    const canViewAll = roles.some((role) =>
      ["ADMIN", "APPROVER", "PHE_DUYET"].includes(role)
    );
    const registration =
      await LeaderMeetingRegistrationRepository.findManagementDetail(
        id,
        canViewAll ? undefined : currentUser.userId
      );
    if (!registration) {
      throw new BaseError(404, "Đăng ký gặp lãnh đạo không tồn tại");
    }
    return mapManagementDetail(registration);
  },

  async approve(id, currentUser) {
    const registration =
      await LeaderMeetingRegistrationRepository.findManagementDetail(
        id,
        currentUser.userId
      );
    if (!registration) {
      throw new BaseError(
        404,
        "Đăng ký gặp lãnh đạo không tồn tại hoặc không thuộc lịch của bạn"
      );
    }
    if (registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.PENDING) {
      throw new BaseError(409, "Chỉ đăng ký đang chờ mới được phê duyệt");
    }

    const updated = await LeaderMeetingRegistrationRepository.approvePending(
      id,
      currentUser.userId,
      {
        trang_thai: TRANG_THAI_GAP_LANH_DAO.APPROVED,
        nguoi_duyet_don: currentUser.userId,
        nguoi_cap_nhat: currentUser.userId,
        thoi_gian_phe_duyet: new Date(),
        thoi_gian_cap_nhat: new Date(),
      }
    );
    if (!updated) {
      throw new BaseError(409, "Đăng ký đã được xử lý bởi yêu cầu khác");
    }
    return mapManagementDetail(updated);
  },

  async reject(id, input, currentUser) {
    const registration =
      await LeaderMeetingRegistrationRepository.findManagementDetail(
        id,
        currentUser.userId
      );
    if (!registration) {
      throw new BaseError(
        404,
        "Đăng ký gặp lãnh đạo không tồn tại hoặc không thuộc lịch của bạn"
      );
    }
    if (registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.PENDING) {
      throw new BaseError(409, "Chỉ đăng ký đang chờ mới được từ chối");
    }

    const now = new Date();
    const updated = await LeaderMeetingRegistrationRepository.rejectPending(
      id,
      currentUser.userId,
      {
        trang_thai: TRANG_THAI_GAP_LANH_DAO.REJECTED,
        ly_do_tu_choi: input.reason,
        nguoi_tu_choi: currentUser.userId,
        nguoi_cap_nhat: currentUser.userId,
        thoi_gian_tu_choi: now,
        thoi_gian_cap_nhat: now,
      }
    );
    if (!updated) {
      throw new BaseError(409, "Đăng ký đã được xử lý bởi yêu cầu khác");
    }
    return mapManagementDetail(updated);
  },

  async process(id, input, currentUser) {
    const registration =
      await LeaderMeetingRegistrationRepository.findManagementDetail(
        id,
        currentUser.userId
      );
    if (!registration) {
      throw new BaseError(
        404,
        "Đăng ký gặp lãnh đạo không tồn tại hoặc không thuộc lịch của bạn"
      );
    }
    if (registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.APPROVED) {
      throw new BaseError(
        409,
        "Chỉ đăng ký đã được phê duyệt mới được bắt đầu xử lý"
      );
    }

    const now = new Date();
    const updated = await LeaderMeetingRegistrationRepository.processApproved(
      id,
      currentUser.userId,
      {
        trang_thai: TRANG_THAI_GAP_LANH_DAO.IN_PROGRESS,
        ghi_chu_xu_ly: input.note || null,
        nguoi_bat_dau_xu_ly: currentUser.userId,
        nguoi_cap_nhat: currentUser.userId,
        thoi_gian_bat_dau_xu_ly: now,
        thoi_gian_cap_nhat: now,
      }
    );
    if (!updated) {
      throw new BaseError(409, "Đăng ký đã được xử lý bởi yêu cầu khác");
    }
    return mapManagementDetail(updated);
  },

  async complete(id, input, currentUser) {
    const registration =
      await LeaderMeetingRegistrationRepository.findManagementDetail(
        id,
        currentUser.userId
      );
    if (!registration) {
      throw new BaseError(
        404,
        "Đăng ký gặp lãnh đạo không tồn tại hoặc không thuộc lịch của bạn"
      );
    }
    if (
      registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.IN_PROGRESS &&
      registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.APPROVED
    ) {
      throw new BaseError(
        409,
        "Chỉ đăng ký đã được phê duyệt hoặc đang xử lý mới được hoàn thành"
      );
    }

    if (!input.note || !input.note.trim()) {
      throw new BaseError(400, "Vui lòng nhập kết quả xử lý của buổi gặp lãnh đạo");
    }

    const now = new Date();
    const updated =
      await LeaderMeetingRegistrationRepository.completeInProgress(
        id,
        currentUser.userId,
        {
          trang_thai: TRANG_THAI_GAP_LANH_DAO.COMPLETED,
          ghi_chu_hoan_thanh: input.note.trim(),
          nguoi_hoan_thanh: currentUser.userId,
          nguoi_cap_nhat: currentUser.userId,
          thoi_gian_hoan_thanh: now,
          thoi_gian_cap_nhat: now,
        }
      );
    if (!updated) {
      throw new BaseError(409, "Đăng ký đã được xử lý bởi yêu cầu khác");
    }
    return { ...mapManagementDetail(updated), ratingEligible: true };
  },

  async cancel(id, input, currentUser) {
    const roles = normalizeRoleNames(currentUser.roles);
    if (!roles.some((role) => ["LANH_DAO", "LEADER"].includes(role))) {
      throw new BaseError(403, "Chỉ lãnh đạo của lịch hẹn được hủy đăng ký");
    }
    const registration = await LeaderMeetingRegistrationRepository.findManagementDetail(
      id,
      currentUser.userId
    );
    if (!registration) {
      throw new BaseError(404, "Đăng ký gặp lãnh đạo không tồn tại hoặc không thuộc lịch của bạn");
    }
    if (registration.trang_thai !== TRANG_THAI_GAP_LANH_DAO.APPROVED) {
      throw new BaseError(409, "Chỉ đăng ký đã được phê duyệt mới được hủy");
    }
    const now = new Date();
    const updated = await LeaderMeetingRegistrationRepository.cancelApproved(
      id,
      currentUser.userId,
      {
        trang_thai: TRANG_THAI_GAP_LANH_DAO.CANCELED,
        ly_do_huy: input.reason,
        nguoi_huy: currentUser.userId,
        nguoi_cap_nhat: currentUser.userId,
        thoi_gian_huy: now,
        thoi_gian_cap_nhat: now,
      }
    );
    if (!updated) throw new BaseError(409, "Đăng ký đã được xử lý bởi yêu cầu khác");
    return mapManagementDetail(updated);
  },

  async getAttachment(registrationId, attachmentId, download, currentUser) {
    const roles = normalizeRoleNames(currentUser.roles);
    const canViewAll = roles.some((role) =>
      ["ADMIN", "APPROVER", "PHE_DUYET"].includes(role)
    );
    const attachment = await LeaderMeetingRegistrationRepository.findAttachment(
      registrationId,
      attachmentId,
      canViewAll ? undefined : currentUser.userId
    );
    if (!attachment) {
      throw new BaseError(404, "Tệp đính kèm không tồn tại hoặc ngoài phạm vi truy cập");
    }
    if (
      download &&
      ["CCCD_FRONT", "CCCD_BACK"].includes(attachment.loai_dinh_kem)
    ) {
      throw new BaseError(403, "Ảnh CCCD chỉ được xem trực tiếp, không được tải xuống");
    }

    const fullPath = path.resolve(process.cwd(), attachment.duong_dan_file);
    if (
      fullPath !== PRIVATE_UPLOAD_ROOT &&
      !fullPath.startsWith(`${PRIVATE_UPLOAD_ROOT}${path.sep}`)
    ) {
      throw new BaseError(404, "Tệp đính kèm không hợp lệ");
    }
    try {
      await fs.promises.access(fullPath, fs.constants.R_OK);
    } catch {
      throw new BaseError(404, "Nội dung tệp đính kèm không tồn tại");
    }

    return {
      fullPath,
      originalName: path.basename(attachment.ten_file_goc).replace(/[\r\n"]/g, "_"),
      mimeType: attachment.mime_type || "application/octet-stream",
      size: attachment.kich_thuoc,
      disposition:
        download && attachment.loai_dinh_kem === "SUPPORTING_DOCUMENT"
          ? "attachment"
          : "inline",
    };
  },
};

export default LeaderMeetingRegistrationService;
