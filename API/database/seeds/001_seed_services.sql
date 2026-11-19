
INSERT INTO services (
    service_name,
    description,
    price,
    duration_minutes,
    is_active
)
SELECT
    data.service_name,
    data.description,
    data.price,
    data.duration_minutes,
    TRUE
FROM (
    VALUES
        (
            'Haircut',
            'Potong rambut sesuai model yang diinginkan pelanggan.',
            25000,
            30
        ),
        (
            'Haircut and Wash',
            'Potong rambut dilanjutkan dengan keramas.',
            35000,
            45
        ),
        (
            'Hair Wash',
            'Layanan keramas dan pembersihan rambut.',
            15000,
            15
        ),
        (
            'Hair Styling',
            'Penataan rambut menggunakan produk styling.',
            20000,
            20
        ),
        (
            'Hair Coloring',
            'Pewarnaan rambut sesuai pilihan warna pelanggan.',
            100000,
            90
        ),
        (
            'Hair Treatment',
            'Perawatan rambut untuk menjaga kesehatan rambut.',
            50000,
            45
        ),
        (
            'Shaving',
            'Layanan pencukuran dan perapian jenggot atau kumis.',
            15000,
            20
        )
) AS data (
    service_name,
    description,
    price,
    duration_minutes
)
WHERE NOT EXISTS (
    SELECT 1
    FROM services existing
    WHERE existing.service_name = data.service_name
);
