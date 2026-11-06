package demo;

import java.util.Map;
import java.util.List;
import java.util.ArrayList;

public class JoinServiceImpl implements JoinService {
    private final JoinMapper joinMapper;

    public JoinServiceImpl(JoinMapper joinMapper) {
        this.joinMapper = joinMapper;
    }

    @Override
    public Map<String, Object> listApplications(String status, String platform, String country, int page, int size) {
        Map<String, Object> out = joinMapper.findForAdmin(status, platform, country, page, size);
        out.put("total", joinMapper.countForAdmin(status, platform, country));
        return out;
    }

    @Override
    public List<String> simple(int page) {
        return new ArrayList<>();
    }
}
