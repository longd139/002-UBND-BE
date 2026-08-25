import prisma from "../config/database.config.js";

const activeHoldingStatuses = [
  "PENDING",
  "APPROVED",
  "IN_PROGRESS",
  "COMPLETED",
];

const LeaderMeetingRegistrationRepository = {
  async createWithGuards({
    slotId,
    phoneNumber,
    citizenId,
    currentDate,
    currentTime,
    data,
    attachments,
  }) {
    return prisma.$transaction(async (tx) => {
      const slot = await tx.khung_gio_gap_lanh_dao.findFirst({
        where: {
          id: slotId,
          is_active: true,
          is_delete: false,
          lich_gap_lanh_dao: {
            is_active: true,
            is_delete: false,
            lanh_dao: { is_active: true, is_delete: false },
          },
        },
        include: {
          lich_gap_lanh_dao: {
            include: {
              lanh_dao: { select: { id: true, ho_va_ten: true } },
            },
          },
        },
      });
      if (!slot) return { conflict: "SLOT_UNAVAILABLE" };

      const appointmentDate = slot.lich_gap_lanh_dao.ngay;
      const appointmentDateText = appointmentDate.toISOString().slice(0, 10);
      if (
        appointmentDateText < currentDate ||
        (appointmentDateText === currentDate && slot.gio_bat_dau <= currentTime)
      ) {
        return { conflict: "SLOT_PASSED" };
      }
      const [heldCount, duplicatePhone, duplicateCitizen] = await Promise.all([
        tx.dang_ky_gap_lanh_dao.count({
          where: { id_khung_gio_gap: slotId, is_active: true, is_delete: false },
        }),
        tx.dang_ky_gap_lanh_dao.findFirst({
          where: {
            ngay_hen: appointmentDate,
            sdt: phoneNumber,
            trang_thai: { in: activeHoldingStatuses },
            is_active: true,
            is_delete: false,
          },
          select: { id: true },
        }),
        tx.dang_ky_gap_lanh_dao.findFirst({
          where: {
            ngay_hen: appointmentDate,
            cccd: citizenId,
            trang_thai: { in: activeHoldingStatuses },
            is_active: true,
            is_delete: false,
          },
          select: { id: true },
        }),
      ]);

      if (duplicatePhone) return { conflict: "PHONE_DAILY_LIMIT" };
      if (duplicateCitizen) return { conflict: "CITIZEN_DAILY_LIMIT" };
      if (heldCount >= slot.suc_chua) return { conflict: "SLOT_FULL" };

      const registration = await tx.dang_ky_gap_lanh_dao.create({
        data: {
          ...data,
          id_khung_gio_gap: slotId,
          ngay_hen: appointmentDate,
          dinh_kem_dang_ky_gap_lanh_dao:
            attachments.length > 0 ? { create: attachments } : undefined,
        },
      });

      return { registration, slot };
    }, { isolationLevel: "Serializable" });
  },

  async findForCitizenLookup({ registrationCode, phoneNumber }) {
    return prisma.dang_ky_gap_lanh_dao.findMany({
      where: {
        ...(registrationCode ? { ma_dang_ky: registrationCode } : {}),
        ...(phoneNumber ? { sdt: phoneNumber } : {}),
        is_active: true,
        is_delete: false,
      },
      orderBy: { thoi_gian_tao: "desc" },
      take: 50,
      select: {
        id: true,
        ma_dang_ky: true,
        ngay_hen: true,
        chu_de: true,
        ly_do: true,
        ho_ten: true,
        sdt: true,
        cccd: true,
        dia_chi: true,
        trang_thai: true,
        ly_do_tu_choi: true,
        thoi_gian_tu_choi: true,
        ly_do_huy: true,
        thoi_gian_huy: true,
        thoi_gian_phe_duyet: true,
        thoi_gian_bat_dau_xu_ly: true,
        thoi_gian_hoan_thanh: true,
        thoi_gian_tao: true,
        thoi_gian_cap_nhat: true,
        khung_gio_gap_lanh_dao: {
          select: {
            id: true,
            gio_bat_dau: true,
            gio_ket_thuc: true,
            lich_gap_lanh_dao: {
              select: {
                id: true,
                dia_diem: true,
                lanh_dao: { select: { id: true, ho_va_ten: true } },
              },
            },
          },
        },
        danh_gia_gap_lanh_dao: {
          select: { id: true },
        },
      },
    });
  },

  async findManagement({
    page,
    limit,
    search,
    status,
    leaderId,
    fromDate,
    toDate,
  }) {
    const where = {
      is_active: true,
      is_delete: false,
      trang_thai: status,
      ngay_hen:
        fromDate || toDate
          ? {
              gte: fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : undefined,
              lte: toDate ? new Date(`${toDate}T23:59:59.999Z`) : undefined,
            }
          : undefined,
      khung_gio_gap_lanh_dao: {
        lich_gap_lanh_dao: {
          id_lanh_dao: leaderId || undefined,
          is_delete: false,
        },
      },
      ...(search
        ? {
            OR: [
              { ma_dang_ky: { contains: search, mode: "insensitive" } },
              { ho_ten: { contains: search, mode: "insensitive" } },
              { sdt: { contains: search } },
              { cccd: { contains: search } },
              { chu_de: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [data, totalItems] = await Promise.all([
      prisma.dang_ky_gap_lanh_dao.findMany({
        where,
        orderBy: [{ ngay_hen: "desc" }, { thoi_gian_tao: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          ma_dang_ky: true,
          ngay_hen: true,
          chu_de: true,
          ly_do: true,
          ho_ten: true,
          sdt: true,
          cccd: true,
          trang_thai: true,
          ghi_chu_hoan_thanh: true,
          ghi_chu_xu_ly: true,
          thoi_gian_phe_duyet: true,
          thoi_gian_bat_dau_xu_ly: true,
          thoi_gian_hoan_thanh: true,
          thoi_gian_tu_choi: true,
          thoi_gian_huy: true,
          thoi_gian_tao: true,
          khung_gio_gap_lanh_dao: {
            select: {
              id: true,
              gio_bat_dau: true,
              gio_ket_thuc: true,
              lich_gap_lanh_dao: {
                select: {
                  id: true,
                  dia_diem: true,
                  lanh_dao: { select: { id: true, ho_va_ten: true } },
                },
              },
            },
          },
          danh_gia_gap_lanh_dao: { select: { id: true } },
        },
      }),
      prisma.dang_ky_gap_lanh_dao.count({ where }),
    ]);
    return { data, totalItems };
  },

  async findManagementDetail(id, leaderId) {
    return prisma.dang_ky_gap_lanh_dao.findFirst({
      where: {
        id,
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: {
            id_lanh_dao: leaderId || undefined,
            is_delete: false,
          },
        },
      },
      select: {
        id: true,
        ma_dang_ky: true,
        ngay_hen: true,
        chu_de: true,
        ly_do: true,
        ho_ten: true,
        sdt: true,
        cccd: true,
        ngay_cap_cccd: true,
        noi_cap_cccd: true,
        dia_chi: true,
        ngay_lam_don: true,
        trang_thai: true,
        ly_do_tu_choi: true,
        ly_do_huy: true,
        ghi_chu_xu_ly: true,
        ghi_chu_hoan_thanh: true,
        thoi_gian_phe_duyet: true,
        thoi_gian_bat_dau_xu_ly: true,
        thoi_gian_hoan_thanh: true,
        thoi_gian_tu_choi: true,
        thoi_gian_huy: true,
        thoi_gian_tao: true,
        thoi_gian_cap_nhat: true,
        khung_gio_gap_lanh_dao: {
          select: {
            id: true,
            gio_bat_dau: true,
            gio_ket_thuc: true,
            lich_gap_lanh_dao: {
              select: {
                id: true,
                ngay: true,
                dia_diem: true,
                ghi_chu: true,
                lanh_dao: {
                  select: {
                    id: true,
                    ho_va_ten: true,
                    email: true,
                    so_dien_thoai: true,
                  },
                },
              },
            },
          },
        },
        nguoi_duyet: { select: { id: true, ho_va_ten: true } },
        nguoi_bat_dau_xu_ly_ref: { select: { id: true, ho_va_ten: true } },
        nguoi_hoan_thanh_ref: { select: { id: true, ho_va_ten: true } },
        nguoi_tu_choi_ref: { select: { id: true, ho_va_ten: true } },
        nguoi_huy_ref: { select: { id: true, ho_va_ten: true } },
        dinh_kem_dang_ky_gap_lanh_dao: {
          orderBy: { thoi_gian_tao: "asc" },
          select: {
            id: true,
            loai_dinh_kem: true,
            ten_file_goc: true,
            mime_type: true,
            kich_thuoc: true,
            thoi_gian_tao: true,
          },
        },
        danh_gia_gap_lanh_dao: {
          select: {
            id: true,
            diem_tong: true,
            tieu_chi: true,
            ly_do: true,
            nhan_xet: true,
            thoi_gian_tao: true,
          },
        },
      },
    });
  },

  async approvePending(id, leaderId, data) {
    const result = await prisma.dang_ky_gap_lanh_dao.updateMany({
      where: {
        id,
        trang_thai: "PENDING",
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: {
            id_lanh_dao: leaderId,
            is_delete: false,
          },
        },
      },
      data,
    });
    if (result.count === 0) return null;
    return LeaderMeetingRegistrationRepository.findManagementDetail(id, leaderId);
  },

  async rejectPending(id, leaderId, data) {
    const result = await prisma.dang_ky_gap_lanh_dao.updateMany({
      where: {
        id,
        trang_thai: "PENDING",
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: {
            id_lanh_dao: leaderId,
            is_delete: false,
          },
        },
      },
      data,
    });
    if (result.count === 0) return null;
    return LeaderMeetingRegistrationRepository.findManagementDetail(id, leaderId);
  },

  async processApproved(id, leaderId, data) {
    const result = await prisma.dang_ky_gap_lanh_dao.updateMany({
      where: {
        id,
        trang_thai: "APPROVED",
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: {
            id_lanh_dao: leaderId,
            is_delete: false,
          },
        },
      },
      data,
    });
    if (result.count === 0) return null;
    return LeaderMeetingRegistrationRepository.findManagementDetail(id, leaderId);
  },

  async completeInProgress(id, leaderId, data) {
    const result = await prisma.dang_ky_gap_lanh_dao.updateMany({
      where: {
        id,
        trang_thai: { in: ["APPROVED", "IN_PROGRESS"] },
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: { id_lanh_dao: leaderId, is_delete: false },
        },
      },
      data,
    });
    if (result.count === 0) return null;
    return LeaderMeetingRegistrationRepository.findManagementDetail(id, leaderId);
  },

  async cancelApproved(id, leaderId, data) {
    const result = await prisma.dang_ky_gap_lanh_dao.updateMany({
      where: {
        id,
        trang_thai: "APPROVED",
        is_active: true,
        is_delete: false,
        khung_gio_gap_lanh_dao: {
          lich_gap_lanh_dao: { id_lanh_dao: leaderId, is_delete: false },
        },
      },
      data,
    });
    if (result.count === 0) return null;
    return LeaderMeetingRegistrationRepository.findManagementDetail(id, leaderId);
  },

  async findAttachment(registrationId, attachmentId, leaderId) {
    return prisma.dinh_kem_dang_ky_gap_lanh_dao.findFirst({
      where: {
        id: attachmentId,
        id_dang_ky: registrationId,
        dang_ky_gap_lanh_dao: {
          is_active: true,
          is_delete: false,
          khung_gio_gap_lanh_dao: {
            lich_gap_lanh_dao: {
              id_lanh_dao: leaderId || undefined,
              is_delete: false,
            },
          },
        },
      },
      select: {
        id: true,
        id_dang_ky: true,
        loai_dinh_kem: true,
        ten_file_goc: true,
        duong_dan_file: true,
        mime_type: true,
        kich_thuoc: true,
      },
    });
  },
};

export default LeaderMeetingRegistrationRepository;
